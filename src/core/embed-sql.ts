import type postgres from "postgres";
import type { EmbedRegistrySqlClient } from "./embed-model-registry.ts";

// Generic bridge from the engine's postgres-js handle to the minimal
// `{ query(sql, params) }` seam several core modules take instead of a
// direct drizzle-orm/postgres dependency (so they stay framework-agnostic).
// Positional `$1`/`$2` placeholders via `sql.unsafe`. Despite the historical
// name this is not embed-specific — `EmbedRegistrySqlClient` and
// `FtsVerifySqlClient` (core/fts-language.ts) are structurally the same
// shape, so one bridge serves both. Accepts either the top-level connection
// or a `sql.begin()` transaction handle, so callers can fold registry writes
// into a larger transaction (see transform.ts promote/demote) instead of
// committing them separately.
export function createRawSqlClient(
  sql: postgres.Sql<{}> | postgres.TransactionSql<{}>,
): EmbedRegistrySqlClient {
  return {
    async query(sqlText, params) {
      const rows = await sql.unsafe(sqlText, [...params] as never[]);
      return rows as unknown as Array<Record<string, unknown>>;
    },
  };
}
