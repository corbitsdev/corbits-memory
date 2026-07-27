import type { RawSql } from "../db/client.ts";
import type { EmbedRegistrySqlClient } from "./embed-model-registry.ts";

// Generic bridge from the engine's postgres-js handle to the minimal
// `{ query(sql, params) }` seam several core modules take instead of a
// direct drizzle-orm/postgres dependency (so they stay framework-agnostic).
// Positional `$1`/`$2` placeholders via `sql.unsafe`. Despite the historical
// name this is not embed-specific — `EmbedRegistrySqlClient` and
// `FtsVerifySqlClient` (core/fts-language.ts) are structurally the same
// shape, so one bridge serves both.
export function createRawSqlClient(sql: RawSql): EmbedRegistrySqlClient {
  return {
    async query(sqlText, params) {
      const rows = await sql.unsafe(sqlText, [...params] as never[]);
      return rows as unknown as Array<Record<string, unknown>>;
    },
  };
}

/** @deprecated Use `createRawSqlClient` — same bridge, name predates its FTS use. */
export const createEmbedRegistrySqlClient = createRawSqlClient;
