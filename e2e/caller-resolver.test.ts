import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryGrantStore, type GrantStore } from "@intx/authz";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

import type { Memory } from "../src/memory.js";
import {
  createMemoryRoutes,
  type CallerResolver,
} from "../src/routes/mount.js";
import {
  allow,
  createTestDb,
  createTestMemory,
  seedPrincipal,
  testDatabaseUrl,
  type TestDb,
} from "./helpers.js";

// A machine caller (e.g. a workflow run) never passes the host's session
// middleware; the host's callerResolver names its tenant and principal.
describe.skipIf(testDatabaseUrl() === undefined)(
  "machine callers through callerResolver",
  () => {
    let db: TestDb;
    let memory: Memory | undefined;
    let grantStore: GrantStore;

    beforeAll(async () => {
      db = await createTestDb();
      await seedPrincipal(db, "acme", "run");
      await seedPrincipal(db, "acme", "other-run");
      await seedPrincipal(db, "globex", "globex-user");
      grantStore = createInMemoryGrantStore([
        ...["add", "search", "forget", "purge"].map((a) => allow("run", a)),
        ...["add", "search", "forget"].map((a) => allow("other-run", a)),
        ...["add", "search"].map((a) => allow("globex-user", a)),
        // Would expose globex's tenant-shared documents if a route ever
        // scoped a read to the URL's tenant instead of the resolved one.
        {
          id: "g-run-globex-tag",
          resource: "memory.tenant:globex",
          action: "search",
          effect: "allow",
          origin: "role",
          conditions: null,
          expiresAt: null,
          roleId: null,
          principalId: "run",
        },
        allow("", "add"),
        allow("\t\n", "add"),
      ]);
      memory = createTestMemory(db, grantStore);
    });

    afterAll(async () => {
      await memory?.close();
      await db?.close();
    });

    function appFor(callerResolver: CallerResolver): Hono<TenantEnv> {
      const app = new Hono<TenantEnv>();
      app.route(
        "/api/tenants/:tenantId/memory",
        createMemoryRoutes({
          memory: memory as Memory,
          requireGrant: createRequireGrant({
            grantStore,
            conditionRegistry: {},
          }),
          callerResolver,
        }),
      );
      return app;
    }

    const as = (tenantId: string, principalId: string) =>
      appFor(() => ({ tenantId, principalId }));

    function post(app: Hono<TenantEnv>, path: string, body: unknown = {}) {
      return app.request(`/api/tenants/ignored/memory${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    async function add(app: Hono<TenantEnv>, title: string): Promise<string> {
      const res = await post(app, "/add", { title, text: `${title} body` });
      expect(res.status).toBe(200);
      return ((await res.json()) as { documentId: string }).documentId;
    }

    test("add writes under the resolved scope, ignoring identity in the body", async () => {
      const res = await post(as("acme", "run"), "/add", {
        title: "Run note",
        text: "written by the run",
        tenantId: "globex",
        principalId: "globex-user",
      });
      expect(res.status).toBe(200);
      const { documentId } = (await res.json()) as { documentId: string };
      const [row] = await db.sql<
        { tenant_id: string; created_by_principal_id: string }[]
      >`
      SELECT d.tenant_id, v.created_by_principal_id
        FROM memory.document d JOIN memory.version v ON v.document_id = d.id
        WHERE d.id = ${documentId}`;
      expect(row).toEqual({
        tenant_id: "acme",
        created_by_principal_id: "run",
      });
    });

    async function documentCount(): Promise<number> {
      const [row] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memory.document`;
      return row?.n ?? 0;
    }

    test("the resolved caller still needs the grant on every route", async () => {
      await seedPrincipal(db, "acme", "ungranted");
      const ungranted = as("acme", "ungranted");
      expect(
        (await post(ungranted, "/add", { title: "t", text: "b" })).status,
      ).toBe(403);
      expect((await post(ungranted, "/search", { query: "q" })).status).toBe(
        403,
      );
      expect(
        (await ungranted.request("/api/tenants/acme/memory/list")).status,
      ).toBe(403);
      expect(
        (await ungranted.request("/api/tenants/acme/memory/feed")).status,
      ).toBe(403);
    });

    test("a resolver that cannot identify the caller is 401", async () => {
      const res = await post(
        appFor(() => null),
        "/add",
        { title: "t", text: "b" },
      );
      expect(res.status).toBe(401);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("unauthorized");
    });

    test("a resolver that throws fails closed without leaking its message", async () => {
      const before = await documentCount();
      const res = await post(
        appFor(() => {
          throw new Error("db connection string with secret=abc123");
        }),
        "/add",
        { title: "t", text: "b" },
      );
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("secret=abc123");
      expect(await documentCount()).toBe(before);
    });

    test.each([
      ["empty", { tenantId: "", principalId: "" }],
      ["whitespace", { tenantId: " ", principalId: "\t\n" }],
    ] as const)(
      "a resolver returning a %s identity is a 500, never a seated scope",
      async (_label, resolved) => {
        // The malformed principal holds an add grant, so a 500 proves the
        // identity was rejected before the grant check.
        const before = await documentCount();
        const res = await post(
          appFor(() => resolved),
          "/add",
          { title: "t", text: "b" },
        );
        expect(await documentCount()).toBe(before);
        expect(res.status).toBe(500);
        expect(
          ((await res.json()) as { error: { code: string } }).error.code,
        ).toBe("invalid_resolved_caller");
      },
    );

    test("search, list and feed read only the resolved tenant, whatever the URL says", async () => {
      const globexShare = await post(as("globex", "globex-user"), "/add", {
        title: "Globex secret plan",
        text: "globex secret plan body",
        share: { tenant: true },
      });
      expect(globexShare.status).toBe(200);
      await add(as("acme", "run"), "Acme run plan");
      const acme = as("acme", "run");

      const search = await acme.request("/api/tenants/globex/memory/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "plan" }),
      });
      expect(search.status).toBe(200);
      const { items } = (await search.json()) as { items: { title: string }[] };
      expect(items.map((i) => i.title)).toContain("Acme run plan");
      expect(items.map((i) => i.title)).not.toContain("Globex secret plan");

      for (const route of ["list", "feed"]) {
        const res = await acme.request(`/api/tenants/globex/memory/${route}`);
        expect(res.status).toBe(200);
        const body = JSON.stringify(await res.json());
        expect(body).toContain("Acme run plan");
        expect(body).not.toContain("Globex secret plan");
      }
    });

    test("forget, purge and retention-class work for the resolved creator only", async () => {
      const owner = as("acme", "run");
      const other = as("acme", "other-run");

      const forgotten = await add(owner, "Forget via run");
      expect((await post(other, `/documents/${forgotten}/forget`)).status).toBe(
        403,
      );
      expect((await post(owner, `/documents/${forgotten}/forget`)).status).toBe(
        200,
      );

      const purged = await add(owner, "Purge via run");
      expect((await post(owner, `/documents/${purged}/purge`)).status).toBe(
        200,
      );

      const classed = await add(owner, "Retention via run");
      const [version] = await db.sql<{ id: string }[]>`
      SELECT id FROM memory.version WHERE document_id = ${classed}`;
      const path = `/versions/${version?.id}/retention-class`;
      expect(
        (await post(other, path, { retention_class: "durable" })).status,
      ).toBe(403);
      expect(
        (await post(owner, path, { retention_class: "durable" })).status,
      ).toBe(200);
    });
  },
);
