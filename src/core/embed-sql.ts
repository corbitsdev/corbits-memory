import type { RawSql } from "../db/client.ts";
import type { EmbedRegistrySqlClient } from "./embed-model-registry.ts";

// Bridges the engine's postgres-js handle to the `EmbedRegistrySqlClient` seam
// that embed-model-registry / embed-worker emit against. Positional `$1`/`$2`
// placeholders via `sql.unsafe`, matching exactly what those modules produce.
export function createEmbedRegistrySqlClient(
  sql: RawSql,
): EmbedRegistrySqlClient {
  return {
    async query(sqlText, params) {
      const rows = await sql.unsafe(sqlText, [...params] as never[]);
      return rows as unknown as Array<Record<string, unknown>>;
    },
  };
}
