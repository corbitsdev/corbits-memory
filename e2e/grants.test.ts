import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import type { Memory } from "../src/memory.js";
import {
  allow,
  createTestApp,
  createTestDb,
  createTestMemory,
  seedPrincipal,
  testDatabaseUrl,
  type TestDb,
} from "./helpers.js";

describe.skipIf(testDatabaseUrl() === undefined)(
  "grants, forget and purge",
  () => {
    let db: TestDb;
    let memory: Memory | undefined;
    let app: Hono<TenantEnv>;

    beforeAll(async () => {
      db = await createTestDb();
      for (const principal of ["alice", "carol", "dave", "erin", "frank"]) {
        await seedPrincipal(db, "acme", principal);
      }
      const grantStore = createInMemoryGrantStore([
        ...["add", "search", "forget", "purge"].map((a) => allow("alice", a)),
        ...["search", "forget", "purge"].map((a) => allow("carol", a)),
        {
          id: "g-carol-tenant-tag",
          resource: "memory.tenant:acme",
          action: "search",
          effect: "allow",
          origin: "role",
          conditions: null,
          expiresAt: null,
          roleId: null,
          principalId: "carol",
        },
        allow("dave", "add"),
        ...["search", "forget"].map((a) => allow("erin", a)),
        ...["capture", "find"].map((a) => allow("frank", a)),
      ]);
      memory = createTestMemory(db, grantStore);
      app = createTestApp({
        memory,
        grantStore,
        callers: {
          alice: { tenantId: "acme", principalId: "alice" },
          carol: { tenantId: "acme", principalId: "carol" },
          dave: { tenantId: "acme", principalId: "dave" },
          erin: { tenantId: "acme", principalId: "erin" },
          frank: { tenantId: "acme", principalId: "frank" },
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

      const [left] = await db.sql<
        { docs: number; versions: number; chunks: number }[]
      >`
      SELECT
        (SELECT count(*)::int FROM memory.document WHERE id = ${documentId}) AS docs,
        (SELECT count(*)::int FROM memory.version WHERE document_id = ${documentId}) AS versions,
        (SELECT count(*)::int FROM memory.chunk WHERE document_id = ${documentId}) AS chunks`;
      expect(left).toEqual({ docs: 0, versions: 0, chunks: 0 });
    });

    test("legacy capture and find grants authorize neither add nor search", async () => {
      expect(
        (await post("frank", "/add", { title: "t", text: "b" })).status,
      ).toBe(403);
      expect((await post("frank", "/search", { query: "q" })).status).toBe(403);
    });

    test("a request without a session is 401", async () => {
      const res = await app.request("/api/tenants/acme/memory/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "q" }),
      });
      expect(res.status).toBe(401);
    });

    test("malformed bodies and out-of-range limits are 400", async () => {
      expect((await post("alice", "/add", { title: "no text" })).status).toBe(
        400,
      );
      expect(
        (await post("alice", "/search", { query: "q", limit: 51 })).status,
      ).toBe(400);
      expect(
        (await post("alice", "/search", { query: "q", kinds: [1] })).status,
      ).toBe(400);
    });

    test("list and search show a document to its creator and to holders of a grant on its tags only", async () => {
      await post("alice", "/add", {
        title: "Alice private",
        text: "only alice",
      });
      await post("alice", "/add", {
        title: "Shared with carol",
        text: "shared with the tenant",
        share: { tenant: true },
      });
      const titles = async (token: string) => {
        const res = await app.request("/api/tenants/acme/memory/list", {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        return JSON.stringify(await res.json());
      };
      const forAlice = await titles("alice");
      const forCarol = await titles("carol");
      const forErin = await titles("erin");
      expect(forAlice).toContain("Alice private");
      expect(forCarol).toContain("Shared with carol");
      expect(forCarol).not.toContain("Alice private");
      expect(forErin).not.toContain("Alice private");
      expect(forErin).not.toContain("Shared with carol");

      const searched = async (token: string) => {
        const res = await post(token, "/search", { query: "only alice" });
        expect(res.status).toBe(200);
        const { items } = (await res.json()) as { items: { title: string }[] };
        return items.map((i) => i.title);
      };
      expect(await searched("alice")).toContain("Alice private");
      expect(await searched("carol")).not.toContain("Alice private");
      expect(await searched("erin")).not.toContain("Alice private");
    });

    test("purge is refused for a non-creator holding the purge grant", async () => {
      const documentId = await addDocument("Carol cannot purge");
      expect(
        (await post("carol", `/documents/${documentId}/purge`)).status,
      ).toBe(403);
    });

    test("list needs the search grant", async () => {
      const res = await app.request("/api/tenants/acme/memory/list", {
        headers: { authorization: "Bearer dave" },
      });
      expect(res.status).toBe(403);
    });

    test("search passes kinds and entity_ids through, and empty arrays filter nothing", async () => {
      await post("alice", "/add", {
        title: "Mango decision",
        text: "Mango wins.",
        kind: "decision",
      });
      await post("alice", "/add", {
        title: "Mango note",
        text: "Mango is ripe.",
      });
      const titles = async (body: Record<string, unknown>) => {
        const res = await post("alice", "/search", body);
        expect(res.status).toBe(200);
        const { items } = (await res.json()) as { items: { title: string }[] };
        return items.map((i) => i.title).sort();
      };
      expect(await titles({ query: "mango", kinds: ["decision"] })).toEqual([
        "Mango decision",
      ]);
      expect(
        await titles({ query: "mango", kinds: [], entity_ids: [] }),
      ).toEqual(["Mango decision", "Mango note"]);
      expect(
        await titles({ query: "mango", entity_ids: ["entity-none"] }),
      ).toEqual([]);
    });

    test("the forget grant does not authorize purge, and forget never deletes rows", async () => {
      const documentId = await addDocument("Erin cannot purge");
      await post("alice", `/documents/${documentId}/forget`);
      expect(
        (await post("erin", `/documents/${documentId}/purge`)).status,
      ).toBe(403);
      const [row] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memory.document WHERE id = ${documentId}`;
      expect(row?.n).toBe(1);
    });

    test("unknown documents and versions are 404, and whitespace ids are 400", async () => {
      expect(
        (await post("alice", "/documents/doc-missing/forget")).status,
      ).toBe(404);
      expect((await post("alice", "/documents/doc-missing/purge")).status).toBe(
        404,
      );
      expect(
        (
          await post("alice", "/versions/ver-missing/retention-class", {
            retention_class: "durable",
          })
        ).status,
      ).toBe(404);
      expect((await post("alice", "/documents/%20/forget")).status).toBe(400);
      expect((await post("alice", "/documents/%20/purge")).status).toBe(400);
      expect(
        (
          await post("alice", "/versions/%20/retention-class", {
            retention_class: "durable",
          })
        ).status,
      ).toBe(400);
    });

    test("retention-class changes a version for its creator only and validates the class", async () => {
      const documentId = await addDocument("Retention target");
      const [version] = await db.sql<{ id: string }[]>`
      SELECT id FROM memory.version WHERE document_id = ${documentId}`;
      const path = `/versions/${version?.id}/retention-class`;

      expect(
        (await post("alice", path, { retention_class: "forever" })).status,
      ).toBe(400);
      expect(
        (await post("carol", path, { retention_class: "durable" })).status,
      ).toBe(403);
      expect(
        (await post("alice", path, { retention_class: "durable" })).status,
      ).toBe(200);
      const [row] = await db.sql<{ retention_class: string }[]>`
      SELECT retention_class FROM memory.version WHERE id = ${version?.id ?? ""}`;
      expect(row?.retention_class).toBe("durable");
    });
  },
);
