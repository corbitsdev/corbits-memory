/**
 * Knowledge-plane (pgvector) schema migrations, callable by host apps.
 * Applies every migrations/*.sql in filename order, each in its own
 * transaction, tracked in a `_migrations` ledger so re-runs are idempotent.
 */
import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FTS_LANGUAGE_TOKEN,
  parseFtsLanguage,
  verifyFtsLanguage,
} from "./core/fts-language.ts";
import { createEmbedRegistrySqlClient } from "./core/embed-sql.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export async function runKnowledgeMigrations(
  databaseUrl: string,
  opts: { log?: (line: string) => void; ftsLanguage?: string } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  // This runner is an env-driven boundary like loadKnowledgeConfig: when the
  // caller does not pass a language it reads the same FTS_LANGUAGE the query
  // side will, so the two cannot diverge by defaulting differently.
  const ftsLanguage = parseFtsLanguage(
    opts.ftsLanguage ?? process.env["FTS_LANGUAGE"],
  );
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`CREATE TABLE IF NOT EXISTS "_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" timestamp NOT NULL DEFAULT now()
    )`;
    const appliedRows = await sql<
      { name: string }[]
    >`SELECT name FROM "_migrations"`;
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
        await tx`INSERT INTO "_migrations" (name) VALUES (${file})`;
      });
      log(`applied ${file}`);
    }

    // The catalog is the authoritative record of which language the
    // generated column was actually built with; a previously-migrated
    // database under a different language must fail loudly here, not
    // degrade recall silently at query time.
    await verifyFtsLanguage(createEmbedRegistrySqlClient(sql), ftsLanguage);
  } finally {
    await sql.end();
  }
}
