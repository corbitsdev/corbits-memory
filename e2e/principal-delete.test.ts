import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";

import type { Memory } from "../src/memory.js";
import {
  allow,
  createTestDb,
  createTestMemory,
  seedPrincipal,
  testDatabaseUrl,
  type TestDb,
} from "./helpers.js";

describe.skipIf(testDatabaseUrl() === undefined)("deleting a principal", () => {
  let db: TestDb;
  let memory: Memory | undefined;

  beforeAll(async () => {
    db = await createTestDb();
    await seedPrincipal(db, "acme", "alice");
    memory = createTestMemory(
      db,
      createInMemoryGrantStore([allow("alice", "add")]),
    );
  });

  afterAll(async () => {
    await memory?.close();
    await db?.close();
  });

  test("keeps the documents and versions they authored, with a null author", async () => {
    const { documentId } = await memory!.add({
      tenantId: "acme",
      principalId: "alice",
      content: {
        title: "Outlives alice",
        text: "kept after the author leaves",
      },
    });

    await db.sql`DELETE FROM public.principal WHERE id = 'alice'`;

    const rows = await db.sql<{ author: string | null }[]>`
      SELECT v.created_by_principal_id AS author FROM memory.version v
        JOIN memory.document d ON d.id = v.document_id
        WHERE d.id = ${documentId}`;
    expect(rows.map((r) => r.author)).toEqual([null]);
  });
});
