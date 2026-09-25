// A database migrated and written by the published 0.1.0 package upgrades in
// place under this version's runMemoryMigrations with no data loss.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";
import { runMigrations } from "@intx/db";
import * as v010 from "@corbits/memory-0.1.0";

import { runMemoryMigrations } from "../src/migrations.ts";
import {
  allow,
  createEmptyDb,
  createTestMemory,
  seedPrincipal,
  testDatabaseUrl,
  testMemoryConfig,
  type TestDb,
} from "./helpers.ts";

const DOCS = [
  { title: "Staging deploys", text: "Staging deploys run from main after every merge." },
  { title: "Vacation policy", text: "Request vacation two weeks ahead." },
];

/** Every row of every memory table, keyed by table. */
type Snapshot = Record<string, string[]>;

describe.skipIf(testDatabaseUrl() === undefined)("upgrading a 0.1.0 database", () => {
  let db: TestDb;
  let before: Snapshot;
  const grantStore = createInMemoryGrantStore([
    allow("alice", "add"),
    allow("alice", "search"),
  ]);

  async function snapshot(): Promise<Snapshot> {
    const tables = await db.sql<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'memory' AND table_type = 'BASE TABLE'
          AND table_name <> '_migrations'
        ORDER BY 1`;
    const result: Snapshot = {};
    for (const { name } of tables) {
      const rows = await db.sql<{ row: string }[]>`
        SELECT to_jsonb(t)::text AS row FROM ${db.sql("memory")}.${db.sql(name)} t
          ORDER BY 1`;
      result[name] = rows.map((r) => r.row);
    }
    return result;
  }

  beforeAll(async () => {
    db = await createEmptyDb();
    await runMigrations(db.config, { schema: "public" });
    await v010.runMemoryMigrations(db.databaseUrl, { ftsLanguage: "english" });
    await seedPrincipal(db, "acme", "alice");

    const legacy = v010.createMemory({
      config: testMemoryConfig(db),
      grantStore,
      conditionRegistry: {},
    });
    try {
      for (const content of DOCS) {
        await legacy.add({ tenantId: "acme", principalId: "alice", content });
      }
    } finally {
      await legacy.close();
    }
    // A distilled claim 0.1.0 already classed as an event: the 0004
    // backfill must not reclassify it on upgrade.
    await db.sql`
      INSERT INTO memory.document (id, tenant_id, kind, title, adapter, external_ref)
      VALUES ('doc-claim', 'acme', 'claim', 'Deploy cadence', 'distiller', 'claim-1')`;
    await db.sql`
      INSERT INTO memory.version
        (id, tenant_id, document_id, version, content_hash, occurred_at,
         created_by_kind, provenance, temporal_class)
      VALUES ('ver-claim', 'acme', 'doc-claim', 1, 'claim', now(), 'agent', 'inferred', 'event')`;
    await db.sql`
      INSERT INTO memory.transform_config (id, tenant_id, name, version)
      VALUES ('tc-1', 'acme', 'chunker', 1)`;
    await db.sql`
      INSERT INTO memory.transform_run (id, tenant_id, config_id, generation, status)
      VALUES ('tr-1', 'acme', 'tc-1', 'gen-1', 'completed')`;
    before = await snapshot();

    const options = { schema: "public", ftsLanguage: "english" };
    await runMemoryMigrations(db.config, options);
    await runMemoryMigrations(db.config, options);
  });

  afterAll(async () => {
    await db?.close();
  });

  test("keeps every row and drops the 0.1.0 migration ledger", async () => {
    expect(before["document"]).toHaveLength(DOCS.length + 1);
    expect(before["raw_capture"]?.length).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
    const [ledger] = await db.sql<{ name: string | null }[]>`
      SELECT to_regclass('memory._migrations')::text AS name`;
    expect(ledger?.name).toBeNull();
  });

  test("finds 0.1.0 documents through this version's search", async () => {
    const memory = createTestMemory(db, grantStore);
    try {
      const { items } = await memory.search({
        tenantId: "acme",
        principalId: "alice",
        query: "staging deploys",
      });
      expect(items[0]?.title).toBe("Staging deploys");
    } finally {
      await memory.close();
    }
  });
});
