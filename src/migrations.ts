/**
 * Knowledge-plane (pgvector) schema migrations, callable by host apps.
 * Applies every migrations/*.sql in filename order, each in its own
 * transaction, tracked in a `_migrations` ledger so re-runs are idempotent.
 */
import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export async function runKnowledgeMigrations(
  databaseUrl: string,
  opts: { log?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
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
      const ddl = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO "_migrations" (name) VALUES (${file})`;
      });
      log(`applied ${file}`);
    }
  } finally {
    await sql.end();
  }
}
