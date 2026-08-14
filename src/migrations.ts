/**
 * Memory-plane (pgvector) schema migrations, callable by host apps.
 * Applies every migrations/*.sql in filename order, each in its own
 * transaction, tracked in memory._migrations so re-runs are idempotent
 * and the ledger never collides with a host's public migration bookkeeping.
 */
import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FTS_LANGUAGE_TOKEN,
  parseFtsLanguage,
  verifyFtsLanguage,
} from "./core/fts-language.ts";
import { createRawSqlClient } from "./core/embed-sql.ts";
import { MEMORY_SCHEMA } from "./db/schema.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export async function runMemoryMigrations(
  databaseUrl: string,
  opts: { log?: (line: string) => void; ftsLanguage?: string } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  // This runner is an env-driven boundary like loadMemoryConfig: when the
  // caller does not pass a language it reads the same FTS_LANGUAGE the query
  // side will, so the two cannot diverge by defaulting differently.
  const ftsLanguage = parseFtsLanguage(
    opts.ftsLanguage ?? process.env["FTS_LANGUAGE"],
  );
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Schema first so the ledger and every later migration can land inside it
    // even when 0001 has not been applied yet (fresh DB) or was skipped.
    await sql.unsafe(
      `CREATE SCHEMA IF NOT EXISTS "${MEMORY_SCHEMA}"`,
    );
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "${MEMORY_SCHEMA}"."_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" timestamp NOT NULL DEFAULT now()
    )`,
    );
    const appliedRows = (await sql.unsafe(
      `SELECT name FROM "${MEMORY_SCHEMA}"."_migrations"`,
    )) as unknown as { name: string }[];
    const applied = new Set(appliedRows.map((row) => row.name));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        log(`(skip) ${file}`);
        continue;
      }
      const raw = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const ddl = raw.replaceAll(FTS_LANGUAGE_TOKEN, ftsLanguage);
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx.unsafe(
          `INSERT INTO "${MEMORY_SCHEMA}"."_migrations" (name) VALUES ($1)`,
          [file],
        );
      });
      log(`applied ${file}`);
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
