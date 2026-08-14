import { createHash, randomUUID } from "node:crypto";
import { type EmbedClientConfig, probeEmbedDims } from "./embed-client.ts";
import { formatCaughtError, log } from "../log.ts";

// pgvector's hnsw/ivfflat indexes on the `vector` type cap at 2000 dims; an
// expression index over `halfvec` (half-precision) raises the cap to 4000.
// Index DDL and the dense query's ORDER BY expression must agree exactly —
// an expression index is only used when the query reproduces the indexed
// expression verbatim — which is why both live in this module.
export const VECTOR_INDEX_MAX_DIMS = 2000;
export const HALFVEC_INDEX_MAX_DIMS = 4000;

/**
 * The cosine-distance ORDER BY expression matching the index that
 * `activateEmbedModel` created for a table of `dims` dimensions. `column`
 * and `vectorParam` are caller-controlled SQL fragments; `dims` is
 * validated here because it is interpolated.
 */
export function cosineDistanceExpr(
  column: string,
  vectorParam: string,
  dims: number,
): string {
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`cosineDistanceExpr: dims must be a positive integer, got ${dims}`);
  }
  if (dims <= VECTOR_INDEX_MAX_DIMS) {
    return `${column} <=> ${vectorParam}::vector`;
  }
  return `(${column}::halfvec(${dims})) <=> ${vectorParam}::halfvec(${dims})`;
}

// Dims are dynamic and discovered, never hard-coded — the dimension travels
// with exactly one artifact: memory.embed_model.dims, discovered here at
// configure time. Never resurrect an EMBED_DIM constant anywhere in this module.
export const MIN_EMBED_DIMS = 64;
// Upper bound is pgvector's halfvec index cap: above 4000 dims no index type
// can serve the cosine query, so activation rejects the model outright
// rather than accepting a table that silently degrades to sequential scan.
export const MAX_EMBED_DIMS = HALFVEC_INDEX_MAX_DIMS;

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

/** Bare table identifier (no schema) for indexes/constraints. */
export const EMBED_TABLE_BARE_PATTERN = /^embedding_[a-f0-9]{16}$/;

/**
 * Fully schema-qualified embedding table name for raw SQL interpolation.
 * Tables live under the memory schema: "memory"."embedding_<key>".
 */
export const EMBED_TABLE_NAME_PATTERN =
  /^"memory"\."embedding_[a-f0-9]{16}"$/;

// This is the only place in this module that ever interpolates a computed
// identifier into raw SQL (see activateEmbedModel below) — a future change
// must not add a second dynamic-DDL path.
export function embeddingTableBareName(modelKey: string): string {
  const bare = `embedding_${modelKey}`;
  if (!EMBED_TABLE_BARE_PATTERN.test(bare)) {
    throw new Error(
      `Computed embedding table name "${bare}" failed identifier validation`,
    );
  }
  return bare;
}

export function embeddingTableName(modelKey: string): string {
  const bare = embeddingTableBareName(modelKey);
  return `"memory"."${bare}"`;
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
  const bare = embeddingTableBareName(modelKey);

  await client.query(
    `INSERT INTO "memory"."embed_model" (id, tenant_id, model_key, model_id, dims, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', now(), now())
     ON CONFLICT (tenant_id, model_key)
     DO UPDATE SET model_id = EXCLUDED.model_id, dims = EXCLUDED.dims, updated_at = now()`,
    [randomUUID(), tenantId, modelKey, config.modelId, dims],
  );

  // The vector is a 1:1 derivative of its chunk, so referential integrity
  // lives in the schema: a hard delete cascades document -> version ->
  // chunk -> embedding with no application cleanup to forget. CREATE TABLE
  // IF NOT EXISTS cannot retrofit the FK onto a pre-existing table — that
  // is a deliberate new-tables-only choice (see IMPLEMENTATION.md for the
  // one-time ALTER).
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${tableName} (
       chunk_id text PRIMARY KEY,
       tenant_id text NOT NULL,
       embedding vector(${dims}),
       CONSTRAINT ${bare}_chunk_fk
         FOREIGN KEY (chunk_id) REFERENCES "memory"."chunk" (id) ON DELETE CASCADE
     )`,
    [],
  );
  // Composite over bare tenant_id: the read path filters tenant_id plus a
  // chunk_id set; this is a B-tree membership filter (fetchChunkVectors also
  // selects embedding). Runs on every activation so a pre-FK table still gets
  // the index.
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${bare}_tenant_chunk_idx ON ${tableName} (tenant_id, chunk_id)`,
    [],
  );

  const indexName = `${bare}_hnsw_idx`;
  if (dims <= VECTOR_INDEX_MAX_DIMS) {
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
  } else {
    // The expression here must stay character-identical to what
    // cosineDistanceExpr emits for these dims, or the planner ignores the
    // index. No ivfflat fallback on this path: halfvec requires
    // pgvector >= 0.7.0 and every such release has hnsw, so a failure here
    // means the extension is too old for halfvec at all — let activation
    // fail loudly at this boundary rather than accept an unindexable model.
    // IF NOT EXISTS also retrofits the index onto a table created before
    // halfvec support existed; on a large populated table this build can
    // take a while.
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} USING hnsw ((embedding::halfvec(${dims})) halfvec_cosine_ops)`,
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
    `SELECT model_key, model_id, dims FROM "memory"."embed_model"
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
