import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";

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

describe.skipIf(testDatabaseUrl() === undefined)("grants, forget and purge", () => {
  let db: TestDb;
  let memory: Memory | undefined;
  let app: Hono<TenantEnv>;

  beforeAll(async () => {
    db = await createTestDb();
    for (const principal of ["alice", "carol", "dave"]) {
      await seedPrincipal(db, "acme", principal);
    }
    const grantStore = createInMemoryGrantStore([
      ...["add", "search", "forget", "purge"].map((a) => allow("alice", a)),
      ...["search", "forget", "purge"].map((a) => allow("carol", a)),
      allow("dave", "add"),
    ]);
    memory = createTestMemory(db, grantStore);
    app = createTestApp({
      memory,
      grantStore,
      callers: {
        alice: { tenantId: "acme", principalId: "alice" },
        carol: { tenantId: "acme", principalId: "carol" },
        dave: { tenantId: "acme", principalId: "dave" },
      },
    });
  });

  afterAll(async () => {
    await memory?.close();
    await db?.close();
  });

  function post(token: string, path: string, body: unknown = {}) {
    return app.request(`/api/tenants/acme/memory${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async function addDocument(title: string): Promise<string> {
    const res = await post("alice", "/add", { title, text: `${title} body` });
    expect(res.status).toBe(200);
    return ((await res.json()) as { documentId: string }).documentId;
  }

  test("search without the memory:search grant is 403", async () => {
    const res = await post("dave", "/search", { query: "anything" });
    expect(res.status).toBe(403);
  });

  test("forget succeeds for the creator and is 403 for anyone else", async () => {
    const documentId = await addDocument("Forget me");

    const other = await post("carol", `/documents/${documentId}/forget`);
    expect(other.status).toBe(403);

    const creator = await post("alice", `/documents/${documentId}/forget`);
    expect(creator.status).toBe(200);
    const [row] = await db.sql<{ status: string }[]>`
      SELECT status FROM memory.version WHERE document_id = ${documentId}`;
    expect(row?.status).toBe("tombstoned");
  });

  test("purge removes the document, its versions and its chunks", async () => {
    const documentId = await addDocument("Purge me");
    const [before] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memory.chunk c
        JOIN memory.version v ON v.id = c.version_id
        WHERE v.document_id = ${documentId}`;
    expect(before?.n).toBeGreaterThan(0);

    const res = await post("alice", `/documents/${documentId}/purge`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ documentId, deleted: true });

    const [left] = await db.sql<{ docs: number; versions: number; chunks: number }[]>`
      SELECT
        (SELECT count(*)::int FROM memory.document WHERE id = ${documentId}) AS docs,
        (SELECT count(*)::int FROM memory.version WHERE document_id = ${documentId}) AS versions,
        (SELECT count(*)::int FROM memory.chunk WHERE document_id = ${documentId}) AS chunks`;
    expect(left).toEqual({ docs: 0, versions: 0, chunks: 0 });
  });
});
