/**
 * Memory-plane (pgvector) schema migrations, callable by host apps.
 * Applies every migrations/*.sql in filename order on each run, the same
 * way Interchange `runMigrations` does: every file is idempotent, so there
 * is no ledger.
 */
import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DBConfig } from "@intx/db";
import {
  FTS_LANGUAGE_TOKEN,
  assertFtsLanguage,
  verifyFtsLanguage,
} from "./core/fts-language.js";
import { createRawSqlClient } from "./core/embed-sql.js";
import { MEMORY_SCHEMA } from "./db/schema.js";

// dirname (not Bun-only `dir`): the packed dist/ layout keeps
// <pkg>/migrations next to <pkg>/dist, so this resolves in Node too.
const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Takes the same `config` and `schema` the host passes Interchange
 * `runMigrations`: `schema` is where the host's `tenant` and `principal`
 * tables live, and the `"public".` foreign-key references in the SQL are
 * rewritten to it. Memory's own tables always live in the `memory` schema.
 * `ftsLanguage` is fixed into the generated tsvector column; pass the same
 * value `loadMemoryConfig` resolves for the query side.
 */
export async function runMemoryMigrations(
  config: DBConfig,
  options: { schema: string; ftsLanguage: string },
): Promise<void> {
  if (options.schema.length === 0) {
    throw new Error("runMemoryMigrations: schema name must not be empty");
  }
  const hostSchema = quoteIdentifier(options.schema);
  const ftsLanguage = assertFtsLanguage(options.ftsLanguage);
  const sql = postgres({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ?? false,
    max: 1,
    onnotice: () => undefined,
    // Replaying ADD COLUMN IF NOT EXISTS still requests an exclusive lock;
    // fail fast behind a long reader instead of stalling every query queued
    // after the lock request.
    connection: { lock_timeout: 5000 },
  });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${MEMORY_SCHEMA}"`);
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const raw = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const ddl = raw
        .replaceAll(FTS_LANGUAGE_TOKEN, ftsLanguage)
        .replace(/"public"\.(?=")/g, `${hostSchema}.`);
      await sql.begin((tx) => tx.unsafe(ddl));
    }

    // The catalog is the authoritative record of which language the
    // generated column was actually built with; a previously-migrated
    // database under a different language must fail loudly here, not
    // degrade recall silently at query time.
    await verifyFtsLanguage(createRawSqlClient(sql), ftsLanguage);
  } finally {
    await sql.end();
  }
}
