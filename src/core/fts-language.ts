/**
 * The full-text-search language contract. The generated tsvector column
 * (migration-time) and plainto_tsquery (query-time) must agree on language
 * or recall silently degrades via mismatched stemming — so the default, the
 * boundary validation, and the applied-vs-configured verification all live
 * here, and both entry points (config loader, migration runner) import them.
 */

export const DEFAULT_FTS_LANGUAGE = "english";

/** Placeholder in migration SQL replaced with the validated language. */
export const FTS_LANGUAGE_TOKEN = "{{FTS_LANGUAGE}}";

// Deliberately excludes `.` — only unqualified pg_catalog text search configs
// are supported (see the schema-qualified handling in verifyFtsLanguage
// below for why: this repo made a choice, not an oversight).
const FTS_LANGUAGE_PATTERN = /^[a-z_]{1,63}$/;

/**
 * Resolve an operator-supplied language (env or option) at the boundary:
 * absent means the default; anything present must be a plain lowercase
 * identifier — it is interpolated into migration DDL after this check.
 * Existence as a real text search config is verified against pg_ts_config
 * by verifyFtsLanguage, which needs a connection.
 */
export function parseFtsLanguage(raw: string | undefined): string {
  if (raw === undefined || raw === "") return DEFAULT_FTS_LANGUAGE;
  if (!FTS_LANGUAGE_PATTERN.test(raw)) {
    throw new Error(
      `FTS_LANGUAGE "${raw}" is not a valid text search config name (expected ${FTS_LANGUAGE_PATTERN})`,
    );
  }
  return raw;
}

/**
 * Memoized serving-path wrapper around verifyFtsLanguage: the first call
 * verifies, success is remembered forever, and a failure clears the memo so
 * a transient DB error at first use does not poison the plane until
 * restart (a real mismatch keeps failing on every retry anyway).
 */
export function createFtsVerification(
  client: FtsVerifySqlClient,
  ftsLanguage: string,
): () => Promise<void> {
  let verified: Promise<void> | undefined;
  return () =>
    (verified ??= verifyFtsLanguage(client, ftsLanguage).catch((err) => {
      verified = undefined;
      throw err;
    }));
}

export interface FtsVerifySqlClient {
  query: (sql: string, params: readonly unknown[]) => Promise<Array<Record<string, unknown>>>;
}

/**
 * Enforce the invariant the env var alone cannot: the language baked into
 * knowledge_chunk.text_fts (read back from the catalog — the authoritative
 * record of what the DDL actually applied) must equal the configured one,
 * and the configured one must be an installed text search config. Throws
 * with a rebuild instruction on mismatch. Run at startup (the migration
 * runner calls it after applying), never per query.
 */
export async function verifyFtsLanguage(
  client: FtsVerifySqlClient,
  ftsLanguage: string,
): Promise<void> {
  const known = await client.query(
    "SELECT 1 FROM pg_ts_config WHERE cfgname = $1",
    [ftsLanguage],
  );
  if (known.length === 0) {
    throw new Error(
      `FTS language "${ftsLanguage}" is not an installed Postgres text search config (pg_ts_config)`,
    );
  }

  const rows = await client.query(
    `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
     FROM pg_attrdef d
     JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE d.adrelid = 'knowledge_chunk'::regclass AND a.attname = 'text_fts'`,
    [],
  );
  const expr = rows[0]?.["expr"];
  if (typeof expr !== "string") {
    throw new Error("knowledge_chunk.text_fts has no generation expression — schema not migrated?");
  }
  // Only unqualified `pg_catalog` configs are supported: FTS_LANGUAGE_PATTERN
  // already refuses to configure a schema-qualified name, so a match here
  // (group 1) means something outside this module's control — a manual
  // ALTER, a restored dump from another install — put a qualified config on
  // the column. Surface that explicitly rather than falling through to the
  // generic "could not read" error, which would misdirect the operator into
  // debugging a parser bug that isn't there.
  const match = /'(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)'::regconfig/.exec(expr);
  if (match === null) {
    throw new Error(
      `Could not read the applied FTS language from knowledge_chunk.text_fts: ${expr}`,
    );
  }
  const [, schema, applied] = match;
  if (schema !== undefined) {
    throw new Error(
      `knowledge_chunk.text_fts was built with the schema-qualified text search config "${schema}.${applied}", ` +
        `but FTS_LANGUAGE only supports unqualified pg_catalog configs. ` +
        `Either drop the schema qualification (move/alias the config into pg_catalog) or rebuild the column — see the recipe below.`,
    );
  }
  if (applied !== ftsLanguage) {
    throw new Error(
      `FTS language mismatch: knowledge_chunk.text_fts was built with "${applied}" but the configuration says "${ftsLanguage}". ` +
        `Search would silently stem queries differently than the index.\n\n` +
        `To rebuild the column under the new language:\n` +
        `  BEGIN;\n` +
        `  ALTER TABLE knowledge_chunk DROP COLUMN text_fts;\n` +
        `  ALTER TABLE knowledge_chunk ADD COLUMN text_fts tsvector\n` +
        `    GENERATED ALWAYS AS (to_tsvector('${ftsLanguage}', "text")) STORED;\n` +
        `  CREATE INDEX CONCURRENTLY knowledge_chunk_text_fts_idx ON knowledge_chunk USING gin (text_fts);\n` +
        `  COMMIT;\n\n` +
        `Both ALTER TABLE statements take an ACCESS EXCLUSIVE lock and rewrite the table ` +
        `(DROP COLUMN then re-adding a STORED generated column forces a full rewrite) — ` +
        `expect a stall on this table for the duration on a populated database; run during a ` +
        `maintenance window. CREATE INDEX CONCURRENTLY cannot run inside the same transaction as ` +
        `the ALTERs on some Postgres versions — if it errors there, commit the ALTERs first, then ` +
        `run the index creation separately. Or, fix FTS_LANGUAGE back to "${applied}" instead.`,
    );
  }
}
