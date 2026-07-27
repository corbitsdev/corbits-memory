import { createHash, randomUUID } from "node:crypto";
import { type EmbedClientConfig, probeEmbedDims } from "./embed-client.ts";
import { formatCaughtError, log } from "../log.ts";

// Dims are dynamic and discovered, never hard-coded — the dimension travels
// with exactly one artifact: the knowledge_embed_model.dims column,
// discovered here at configure time. Never resurrect an EMBED_DIM constant
// anywhere in this module.
export const MIN_EMBED_DIMS = 64;
export const MAX_EMBED_DIMS = 4096;

export class DimsOutOfBoundsError extends Error {
  constructor(public readonly dims: number) {
    super(
      `Discovered embedding dims ${dims} is out of the allowed bounds [${MIN_EMBED_DIMS}, ${MAX_EMBED_DIMS}]`,
    );
    this.name = "DimsOutOfBoundsError";
  }
}

export async function discoverModelDims(
  config: EmbedClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const dims = await probeEmbedDims(config, fetchImpl);
  if (dims < MIN_EMBED_DIMS || dims > MAX_EMBED_DIMS) {
    throw new DimsOutOfBoundsError(dims);
  }
  return dims;
}

// The stable per-(baseUrl, modelId) key. Never derive the table name from
// unsanitized user input directly — this hash is the only source.
export function computeModelKey(baseUrl: string, modelId: string): string {
  return createHash("sha256")
    .update(`${baseUrl}|${modelId}`)
    .digest("hex")
    .slice(0, 16);
}

export const EMBED_TABLE_NAME_PATTERN = /^knowledge_embedding_[a-f0-9]{16}$/;

// This is the only place in this module that ever interpolates a computed
// identifier into raw SQL (see activateEmbedModel below) — a future change
// must not add a second dynamic-DDL path.
export function embeddingTableName(modelKey: string): string {
  const tableName = `knowledge_embedding_${modelKey}`;
  if (!EMBED_TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `Computed embedding table name "${tableName}" failed identifier validation`,
    );
  }
  return tableName;
}

// Minimal DB seam — this module takes no dependency on drizzle-orm/postgres
// directly so it stays framework-agnostic; the caller wires a real client
// against this shape. The engine's `RawSql` (postgres-js) handle's
// `sql.unsafe(query, params)` method satisfies this interface structurally.
export interface EmbedRegistrySqlClient {
  query: (sql: string, params: readonly unknown[]) => Promise<Array<Record<string, unknown>>>;
}

export interface ActivateEmbedModelResult {
  tableName: string;
  dims: number;
  modelId: string;
  modelKey: string;
}

export async function activateEmbedModel(
  client: EmbedRegistrySqlClient,
  tenantId: string,
  config: EmbedClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ActivateEmbedModelResult> {
  const dims = await discoverModelDims(config, fetchImpl);
  const modelKey = computeModelKey(config.baseUrl, config.modelId);
  const tableName = embeddingTableName(modelKey);

  await client.query(
    `INSERT INTO knowledge_embed_model (id, tenant_id, model_key, model_id, dims, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', now(), now())
     ON CONFLICT (tenant_id, model_key)
     DO UPDATE SET model_id = EXCLUDED.model_id, dims = EXCLUDED.dims, updated_at = now()`,
    [randomUUID(), tenantId, modelKey, config.modelId, dims],
  );

  await client.query(
    `CREATE TABLE IF NOT EXISTS ${tableName} (
       chunk_id text PRIMARY KEY,
       tenant_id text NOT NULL,
       embedding vector(${dims})
     )`,
    [],
  );

  const indexName = `${tableName}_hnsw_idx`;
  try {
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} USING hnsw (embedding vector_cosine_ops)`,
      [],
    );
  } catch (err) {
    const errMessage = formatCaughtError(err);
    log.warn(
      `embed-model-registry: hnsw index creation failed; falling back to ivfflat: ${errMessage}`,
      { indexName, error: errMessage },
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
      [],
    );
  }

  return { tableName, dims, modelId: config.modelId, modelKey };
}

export interface ActiveEmbedTable {
  tableName: string;
  dims: number;
  modelId: string;
}

export async function resolveActiveEmbedTable(
  client: EmbedRegistrySqlClient,
  tenantId: string,
): Promise<ActiveEmbedTable | null> {
  const rows = await client.query(
    `SELECT model_key, model_id, dims FROM knowledge_embed_model
     WHERE tenant_id = $1 AND status = 'active'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return null;

  const modelKey = row.model_key as string;
  return {
    tableName: embeddingTableName(modelKey),
    dims: row.dims as number,
    modelId: row.model_id as string,
  };
}
