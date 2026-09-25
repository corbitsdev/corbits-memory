import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runMigrations } from "@intx/db";

import { runMemoryMigrations } from "../src/migrations.ts";
import { createEmptyDb, testDatabaseUrl, type TestDb } from "./helpers.ts";

const options = { schema: "public", ftsLanguage: "english" };

describe.skipIf(testDatabaseUrl() === undefined)("memory migrations", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createEmptyDb();
    await runMigrations(db.config, { schema: "public" });
  });

  afterAll(async () => {
    await db.close();
  });

  async function snapshot(schema: string): Promise<string[]> {
    // Tables, constraints and indexes: pgvector's extension objects land in
    // public by design and are not memory's tables.
    const rows = await db.sql<{ item: string }[]>`
      SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type AS item
        FROM information_schema.columns WHERE table_schema = ${schema}
      UNION ALL
      SELECT 'constraint ' || conrelid::regclass || ' ' || pg_get_constraintdef(c.oid)
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = ${schema}
      UNION ALL
      SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = ${schema}
      ORDER BY 1`;
    return rows.map((r) => r.item);
  }

  test("a second run is a no-op and no tables land in public", async () => {
    const publicBefore = await snapshot("public");

    await runMemoryMigrations(db.config, options);
    const afterFirst = await snapshot("memory");
    await runMemoryMigrations(db.config, options);
    const afterSecond = await snapshot("memory");

    expect(afterFirst.some((i) => i.startsWith("column document.id "))).toBe(true);
    expect(afterSecond).toEqual(afterFirst);
    expect(await snapshot("public")).toEqual(publicBefore);
  });

  test("a replay behind a long reader fails on the lock timeout instead of waiting", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = db.sql.begin(async (tx) => {
      await tx`SELECT count(*) FROM memory.version`;
      await held;
    });
    try {
      const started = Date.now();
      await expect(runMemoryMigrations(db.config, options)).rejects.toThrow(
        "lock timeout",
      );
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      release();
      await reader;
    }
  }, 30_000);
});

describe.skipIf(testDatabaseUrl() === undefined)("memory migrations in a non-public host schema", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createEmptyDb();
    await runMigrations(db.config, { schema: "hub" });
  });

  afterAll(async () => {
    await db.close();
  });

  test("foreign keys point at the host schema, and a replay against another schema fails", async () => {
    const hub = { schema: "hub", ftsLanguage: "english" };
    await runMemoryMigrations(db.config, hub);
    await runMemoryMigrations(db.config, hub);

    const targets = await db.sql<{ target: string }[]>`
      SELECT DISTINCT confrelid::regclass::text AS target
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'memory' AND c.contype = 'f'
          AND confrelid::regclass::text NOT LIKE 'memory.%'
        ORDER BY 1`;
    expect(targets.map((t) => t.target)).toEqual(["hub.principal", "hub.tenant"]);

    await runMigrations(db.config, { schema: "public" });
    await expect(runMemoryMigrations(db.config, options)).rejects.toThrow(
      "already exists",
    );
  });
});

describe.skipIf(testDatabaseUrl() === undefined)("upgrading a database the ledger runner left before 0004", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createEmptyDb();
    await runMigrations(db.config, { schema: "public" });
    const dir = join(import.meta.dirname, "..", "migrations");
    for (const file of (await readdir(dir)).sort()) {
      if (file >= "0004") break;
      const raw = await readFile(join(dir, file), "utf8");
      await db.sql.unsafe(raw.replaceAll("{{FTS_LANGUAGE}}", "english"));
    }
    await db.sql`
      INSERT INTO memory.document (id, tenant_id, kind, title, adapter, external_ref)
      VALUES ('doc-old', 'acme', 'note', 'Old claim', 'test', 'old')`;
    await db.sql`
      INSERT INTO memory.version
        (id, tenant_id, document_id, version, content_hash, occurred_at,
         created_by_kind, provenance)
      VALUES ('ver-old', 'acme', 'doc-old', 1, 'h', now(), 'agent', 'inferred')`;
    await db.sql`
      INSERT INTO public.tenant (id, name, slug, domain)
      VALUES ('acme', 'acme', 'acme', 'acme.test')`;
  });

  afterAll(async () => {
    await db.close();
  });

  test("the temporal_class backfill applies once and a later replay leaves new rows alone", async () => {
    await runMemoryMigrations(db.config, options);
    const [old] = await db.sql<{ temporal_class: string }[]>`
      SELECT temporal_class FROM memory.version WHERE id = 'ver-old'`;
    expect(old?.temporal_class).toBe("state");

    await db.sql`
      INSERT INTO memory.version
        (id, tenant_id, document_id, version, content_hash, occurred_at,
         created_by_kind, provenance, temporal_class)
      VALUES ('ver-new', 'acme', 'doc-old', 2, 'h2', now(), 'agent', 'inferred', 'event')`;
    await runMemoryMigrations(db.config, options);
    const [fresh] = await db.sql<{ temporal_class: string }[]>`
      SELECT temporal_class FROM memory.version WHERE id = 'ver-new'`;
    expect(fresh?.temporal_class).toBe("event");
  });
});
