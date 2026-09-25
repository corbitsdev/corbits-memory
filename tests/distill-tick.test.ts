import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";

import { runDistillTick } from "../src/distiller/tick.ts";
import { createMemoryHttpClient } from "../src/http-client.ts";
import type { Memory } from "../src/memory.ts";
import {
  allow,
  createTestApp,
  createTestDb,
  createTestMemory,
  seedPrincipal,
  testDatabaseUrl,
  type TestDb,
} from "./lib/db-harness.ts";

describe.skipIf(testDatabaseUrl() === undefined)("distill tick", () => {
  let db: TestDb;
  let memory: Memory | undefined;
  let tick: (after: number) => ReturnType<typeof runDistillTick>;

  beforeAll(async () => {
    db = await createTestDb();
    await seedPrincipal(db, "acme", "alice");
    await seedPrincipal(db, "acme", "distiller");
    const grantStore = createInMemoryGrantStore([
      allow("alice", "add"),
      allow("distiller", "add"),
      allow("distiller", "search"),
      {
        id: "g-distiller-tenant-tag",
        resource: "memory.tenant:acme",
        action: "search",
        effect: "allow",
        origin: "role",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: "distiller",
      },
    ]);
    memory = createTestMemory(db, grantStore);
    const app = createTestApp({
      memory,
      grantStore,
      callers: {
        alice: { tenantId: "acme", principalId: "alice" },
        distiller: { tenantId: "acme", principalId: "distiller" },
      },
    });
    const client = (authToken: string) =>
      createMemoryHttpClient({
        baseUrl: "http://hub.test",
        tenantId: "acme",
        authToken,
        fetch: ((input: string, init?: RequestInit) =>
          app.request(input, init)) as typeof fetch,
      });

    for (const title of ["Standup notes", "Deploy checklist"]) {
      await client("alice").add({
        title,
        text: `${title} body`,
        share: { tenant: true },
      });
    }
    tick = (after) =>
      runDistillTick({
        client: client("distiller"),
        after,
        distill: async (entry) => ({
          action: "write",
          title: `Claim from ${entry.title}`,
          text: `Distilled: ${entry.title}`,
        }),
      });
  });

  afterAll(async () => {
    await memory?.close();
    await db?.close();
  });

  async function documentCount(): Promise<number> {
    const [row] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memory.document`;
    return row?.n ?? 0;
  }

  test("a tick writes one distilled claim per captured document, and a replay from its cursor writes nothing", async () => {
    const first = await tick(0);
    expect(first.wrote).toBe(2);
    expect(await documentCount()).toBe(4);
    const claims = await db.sql<{ provenance: string; source: string }[]>`
      SELECT v.provenance, src_doc.title AS source
        FROM memory.version v
        JOIN memory.edge e ON e.rel = 'derived_from' AND e.from_ref = v.document_id
        JOIN memory.version src ON src.id = e.to_ref
        JOIN memory.document src_doc ON src_doc.id = src.document_id
        WHERE v.generator_agent_id IS NOT NULL
        ORDER BY source`;
    expect([...claims]).toEqual([
      { provenance: "inferred", source: "Deploy checklist" },
      { provenance: "inferred", source: "Standup notes" },
    ]);

    const second = await tick(first.nextCursor);
    expect(second.wrote).toBe(0);
    expect(await documentCount()).toBe(4);
  });
});
