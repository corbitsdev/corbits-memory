import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createInMemoryGrantStore } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";

import type { Memory, TimelineEvent } from "../memory.ts";
import { registerMemoryRoutes } from "./mount.ts";
import type { RouteDeps } from "./deps.ts";

function grant(principalId: string, action: string): GrantRule {
  return {
    id: `g-${principalId}-${action}`,
    resource: "memory",
    action,
    effect: "allow",
    origin: "role",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId,
  };
}

const PRINCIPAL = "p1";
const TENANT = "t1";
const SECRET_TITLE = "Q3 layoffs — draft list";
const PUBLIC_TITLE = "team standup notes";

function stubPlane(opts?: {
  timelineCatalog?: Array<
    TimelineEvent & { visibleTo: readonly string[] | "tenant" }
  >;
}) {
  const added: { title: string; tenantId: string; principalId: string }[] = [];
  const searched: Array<{
    kinds: string[] | undefined;
    entityIds: string[] | undefined;
    limit: number | undefined;
  }> = [];
  const catalog = opts?.timelineCatalog ?? [];
  const plane: Memory = {
    search: async (p) => {
      searched.push({ kinds: p.kinds, entityIds: p.entityIds, limit: p.limit });
      return { items: [], evidence: "none" };
    },
    add: async (p) => {
      added.push({
        title: p.content?.title ?? "",
        tenantId: p.tenantId,
        principalId: p.principalId,
      });
      return { documentId: "doc-stub", versionId: "ver-stub" };
    },
    list: async (p) => {
      return catalog
        .filter(
          (e) =>
            e.tenantId === p.tenantId &&
            (e.visibleTo === "tenant" || e.visibleTo.includes(p.principalId)),
        )
        .map(({ visibleTo: _v, ...event }) => event);
    },
    close: async () => {},
  };
  return { plane, added, searched };
}

function buildApp(
  grants: GrantRule[],
  opts?: {
    timelineCatalog?: Array<
      TimelineEvent & { visibleTo: readonly string[] | "tenant" }
    >;
    principalId?: string;
  },
) {
  const { plane, added, searched } = stubPlane(opts);
  const grantConfig = {
    grantStore: createInMemoryGrantStore(grants),
    conditionRegistry: {},
  };
  const deps: RouteDeps = {
    memory: plane,
    grants: grantConfig,
    requireGrant: createRequireGrant(grantConfig),
  };

  const principalId = opts?.principalId ?? PRINCIPAL;
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", {
      id: principalId,
      tenantId: TENANT,
      kind: "user",
      refId: "u1",
      status: "active",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    c.set("tenant", {
      id: TENANT,
      name: "T1",
      slug: "t1",
      domain: "t1.test",
      parentId: null,
      config: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await next();
  });
  registerMemoryRoutes(app, deps);
  return { app, added, searched };
}

function buildAppWithCallerResolver(
  grants: GrantRule[],
  callerResolver: RouteDeps["callerResolver"],
) {
  const { plane, added } = stubPlane();
  const grantConfig = {
    grantStore: createInMemoryGrantStore(grants),
    conditionRegistry: {},
  };
  const deps: RouteDeps = {
    memory: plane,
    grants: grantConfig,
    requireGrant: createRequireGrant(grantConfig),
    ...(callerResolver !== undefined ? { callerResolver } : {}),
  };
  // No tenant-session middleware mounted at all — a machine caller has no
  // browser session; `callerResolver` is the only source of identity here.
  const app = new Hono<TenantEnv>();
  registerMemoryRoutes(app, deps);
  return { app, added };
}

function buildAppWithoutPrincipal() {
  const { plane } = stubPlane();
  const grantConfig = {
    grantStore: createInMemoryGrantStore([]),
    conditionRegistry: {},
  };
  const deps: RouteDeps = {
    memory: plane,
    grants: grantConfig,
    requireGrant: createRequireGrant(grantConfig),
  };
  const app = new Hono<TenantEnv>();
  registerMemoryRoutes(app, deps);
  return app;
}

const jsonPost = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const LIST_CATALOG: Array<
  TimelineEvent & { visibleTo: readonly string[] | "tenant" }
> = [
  {
    at: "2026-01-02T00:00:00.000Z",
    title: PUBLIC_TITLE,
    source: "mcp",
    tenantId: TENANT,
    principalId: "alice",
    visibleTo: "tenant",
  },
  {
    at: "2026-01-01T00:00:00.000Z",
    title: SECRET_TITLE,
    source: "mcp",
    tenantId: TENANT,
    principalId: "alice",
    visibleTo: ["alice"],
  },
];

describe("memory HTTP routes", () => {
  test("add with the add grant writes under the caller's scope", async () => {
    const { app, added } = buildApp([
      grant(PRINCIPAL, "add"),
      grant(PRINCIPAL, "search"),
    ]);
    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documentId: string; versionId: string };
    expect(body.documentId).toBe("doc-stub");
    expect(body.versionId).toBe("ver-stub");
    expect(added).toEqual([
      { title: "t", tenantId: TENANT, principalId: PRINCIPAL },
    ]);
  });

  test("add without the add grant is 403", async () => {
    const { app, added } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(403);
    expect(added).toHaveLength(0);
  });

  test("legacy capture grant does not authorize add", async () => {
    const { app, added } = buildApp([grant(PRINCIPAL, "capture")]);
    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(403);
    expect(added).toHaveLength(0);
  });

  test("add validates the body (400 on missing text)", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "add")]);
    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({ title: "t" }),
    );
    expect(res.status).toBe(400);
  });

  test("search with the search grant returns a result", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/tenants/t1/memory/search",
      jsonPost({ query: "hello" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      evidence: string;
    };
    expect(body.items).toEqual([]);
    expect(body.evidence).toBe("none");
  });

  test("search requires the search grant", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "add")]);
    const res = await app.request(
      "/api/tenants/t1/memory/search",
      jsonPost({ query: "hi" }),
    );
    expect(res.status).toBe(403);
  });

  test("legacy find grant does not authorize search", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "find")]);
    const res = await app.request(
      "/api/tenants/t1/memory/search",
      jsonPost({ query: "hi" }),
    );
    expect(res.status).toBe(403);
  });

  test("search rejects out-of-range limit (400)", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/tenants/t1/memory/search",
      jsonPost({ query: "hi", limit: 999 }),
    );
    expect(res.status).toBe(400);
  });

  test("search threads kinds and entity_ids through to the plane", async () => {
    const { app, searched } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/tenants/t1/memory/search",
      jsonPost({
        query: "hello",
        kinds: ["artifact", "task"],
        entity_ids: ["e1", "e2"],
      }),
    );
    expect(res.status).toBe(200);
    expect(searched).toEqual([
      {
        kinds: ["artifact", "task"],
        entityIds: ["e1", "e2"],
        limit: undefined,
      },
    ]);
  });

  test("search with no kinds/entity_ids leaves them unset on the plane call", async () => {
    const { app, searched } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/tenants/t1/memory/search",
      jsonPost({ query: "hello" }),
    );
    expect(res.status).toBe(200);
    expect(searched).toEqual([
      { kinds: undefined, entityIds: undefined, limit: undefined },
    ]);
  });

  test("search rejects a non-string-array kinds (400)", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/tenants/t1/memory/search",
      jsonPost({ query: "hi", kinds: [1, 2] }),
    );
    expect(res.status).toBe(400);
  });

  test("search passes an empty kinds/entity_ids array through unchanged", async () => {
    const { app, searched } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/tenants/t1/memory/search",
      jsonPost({ query: "hello", kinds: [], entity_ids: [] }),
    );
    expect(res.status).toBe(200);
    expect(searched).toEqual([
      { kinds: [], entityIds: [], limit: undefined },
    ]);
  });

  test("list requires the search grant", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "add")]);
    const res = await app.request("/api/tenants/t1/memory/list");
    expect(res.status).toBe(403);
  });

  test("list never returns a title private to another principal", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "search")], {
      timelineCatalog: LIST_CATALOG,
      principalId: PRINCIPAL,
    });
    const res = await app.request("/api/tenants/t1/memory/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: TimelineEvent[] };
    expect(body.events.map((e) => e.title)).toEqual([PUBLIC_TITLE]);
    expect(body.events.map((e) => e.title)).not.toContain(SECRET_TITLE);
  });

  test("list returns a private title only to the allowed principal", async () => {
    const { app } = buildApp([grant("alice", "search")], {
      timelineCatalog: LIST_CATALOG,
      principalId: "alice",
    });
    const res = await app.request("/api/tenants/t1/memory/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: TimelineEvent[] };
    expect(body.events.map((e) => e.title)).toContain(SECRET_TITLE);
  });

  test("missing principal is 401", async () => {
    const app = buildAppWithoutPrincipal();
    const res = await app.request(
      "/api/tenants/t1/memory/search",
      jsonPost({ query: "hi" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("memory HTTP routes — machine caller (callerResolver)", () => {
  const RUN_TENANT = "tenant-run";
  const RUN_PRINCIPAL = "run-principal";

  test("add with the add grant writes under the resolved run's scope", async () => {
    const { app, added } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "add")],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(200);
    expect(added).toEqual([
      { title: "t", tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL },
    ]);
  });

  test("a request body naming a different tenant/principal is ignored — the resolved caller always wins", async () => {
    const { app, added } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "add")],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({
        title: "t",
        text: "body",
        tenantId: "tenant-evil",
        principalId: "attacker",
      }),
    );
    expect(res.status).toBe(200);
    expect(added).toEqual([
      { title: "t", tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL },
    ]);
  });

  test("grantGuard still applies to a machine caller: no grant is 403", async () => {
    const { app, added } = buildAppWithCallerResolver(
      [],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(403);
    expect(added).toHaveLength(0);
  });

  test("a grant for a different principal does not authorize this machine caller", async () => {
    const { app, added } = buildAppWithCallerResolver(
      [grant("some-other-principal", "add")],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(403);
    expect(added).toHaveLength(0);
  });

  test("an unresolvable caller is 401, never falls through to a browser principal", async () => {
    const { app } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "add")],
      () => null,
    );
    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });
});
