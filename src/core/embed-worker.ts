import { embedTexts, type EmbedClientConfig } from "./embed-client.ts";
import {
  EMBED_TABLE_NAME_PATTERN,
  type ActiveEmbedTable,
  type EmbedRegistrySqlClient,
} from "./embed-model-registry.ts";

export interface EmbeddableChunk {
  id: string;
  text: string;
}

export interface EmbedChunksResult {
  embedded: number;
  rejected: Array<{ chunkId: string; reason: string }>;
  // Populated (never thrown) when the embed client itself failed — chunks
  // stay unembedded and the caller is expected to log this.
  clientError?: { name: string; message: string };
}

const NOOP_RESULT: EmbedChunksResult = { embedded: 0, rejected: [] };

function assertValidTableName(tableName: string): void {
  if (!EMBED_TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `Resolved embed table name "${tableName}" failed identifier validation`,
    );
  }
}

/**
 * Embeds and stores vectors for a known, already-inserted set of
 * memory_chunk rows — the capture service's counterpart to a pending-chunk
 * scanner: the caller already knows exactly which chunks are new (it just
 * inserted them), so there is no LEFT JOIN discovery step here.
 *
 * Client failures (timeout, HTTP error, SSRF-rejected config) leave every
 * chunk unembedded and are reported via `clientError`, never thrown —
 * capture must never fail because the embed endpoint is down. A per-chunk
 * dims mismatch is reported via `rejected` instead of aborting the batch.
 */
export async function embedChunks(
  client: EmbedRegistrySqlClient,
  tenantId: string,
  activeTable: ActiveEmbedTable,
  chunks: readonly EmbeddableChunk[],
  embedClientConfig: EmbedClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<EmbedChunksResult> {
  if (chunks.length === 0) return NOOP_RESULT;
  assertValidTableName(activeTable.tableName);

  let vectors: number[][];
  try {
    vectors = await embedTexts(
      chunks.map((chunk) => chunk.text),
      embedClientConfig,
      fetchImpl,
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      embedded: 0,
      rejected: [],
      clientError: { name: error.name, message: error.message },
    };
  }

  const rejected: Array<{ chunkId: string; reason: string }> = [];
  let embedded = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const vector = vectors[i];

    if (!vector || vector.length !== activeTable.dims) {
      rejected.push({
        chunkId: chunk.id,
        reason: `Expected ${activeTable.dims}-dim vector for model ${activeTable.modelId}, got ${vector ? vector.length : 0}`,
      });
      continue;
    }

    await client.query(
      `INSERT INTO ${activeTable.tableName} (chunk_id, tenant_id, embedding)
       VALUES ($1, $2, $3)
       ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [chunk.id, tenantId, JSON.stringify(vector)],
    );
    embedded++;
  }

  return { embedded, rejected };
}
