import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createInMemoryGrantStore } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";

import type { KnowledgePlane, TimelineEvent } from "../knowledge.ts";
import { mountKnowledgeRoutes } from "./mount.ts";
import type { RouteDeps } from "./deps.ts";

function grant(principalId: string, action: string): GrantRule {
  return {
    id: `g-${principalId}-${action}`,
    resource: "knowledge",
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
const OTHER = "p2";
const TENANT = "t1";

const SECRET_TITLE = "Q3 layoffs — draft list";
const PUBLIC_TITLE = "team standup notes";

// A knowledge plane stub that records captures and returns fixed results.
// Timeline applies a simple ACL model so route tests can prove the route
// never invents titles and always scopes by the caller's principal.
function stubPlane(opts?: {
  timelineCatalog?: Array<
    TimelineEvent & { visibleTo: readonly string[] | "tenant" }
  >;
}) {
  const captured: { title: string; tenantId: string; principalId: string }[] =
    [];
  const catalog = opts?.timelineCatalog ?? [];
  const plane: KnowledgePlane = {
    search: async () => ({ hits: [], evidence: "none" }),
    ask: async () => ({ text: "", citations: [], evidence: "none" }),
    capture: async (p) => {
      captured.push({
        title: p.title,
        tenantId: p.tenantId,
        principalId: p.principalId,
      });
    },
    timeline: async (p) => {
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
  return { plane, captured };
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
  const { plane, captured } = stubPlane(opts);
  const grantConfig = {
    grantStore: createInMemoryGrantStore(grants),
    conditionRegistry: {},
  };
  const deps: RouteDeps = {
    knowledge: plane,
    grants: grantConfig,
    requireGrant: createRequireGrant(grantConfig),
  };

  const principalId = opts?.principalId ?? PRINCIPAL;
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    // Interchange's tenant middleware puts both principal + tenant on the
    // context; requireGrant reads tenant.id, our caller() reads principal.
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
  mountKnowledgeRoutes(app, deps);
  return { app, captured };
}

// Mirrors a host that mounts the knowledge routes outside the tenant prefix
// Interchange's middleware covers — no principal ever lands on the context.
function buildAppWithoutPrincipal() {
  const { plane } = stubPlane();
  const grantConfig = {
    grantStore: createInMemoryGrantStore([]),
    conditionRegistry: {},
  };
  const deps: RouteDeps = {
    knowledge: plane,
    grants: grantConfig,
    requireGrant: createRequireGrant(grantConfig),
  };
  const app = new Hono<TenantEnv>();
  mountKnowledgeRoutes(app, deps);
  return app;
}

const jsonPost = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const TIMELINE_CATALOG: Array<
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
    // Private to alice only — p1 must never see this title on the wire.
    visibleTo: ["alice"],
  },
];

describe("knowledge HTTP routes", () => {
  test("capture with the capture grant writes under the caller's scope", async () => {
    const { app, captured } = buildApp([
      grant(PRINCIPAL, "capture"),
      grant(PRINCIPAL, "search"),
    ]);
    const res = await app.request(
      "/api/knowledge/capture",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(200);
    expect(captured).toEqual([
      { title: "t", tenantId: TENANT, principalId: PRINCIPAL },
    ]);
  });

  test("capture without the capture grant is 403", async () => {
    const { app, captured } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/knowledge/capture",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  test("capture validates the body (400 on missing text)", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "capture")]);
    const res = await app.request(
      "/api/knowledge/capture",
      jsonPost({ title: "t" }),
    );
    expect(res.status).toBe(400);
  });

  test("search with the search grant returns a result", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/knowledge/search",
      jsonPost({ query: "hello" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evidence: string };
    expect(body.evidence).toBe("none");
  });

  test("search requires the search grant", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "capture")]);
    const res = await app.request(
      "/api/knowledge/search",
      jsonPost({ query: "hi" }),
    );
    expect(res.status).toBe(403);
  });

  test("search rejects out-of-range k (400)", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/knowledge/search",
      jsonPost({ query: "hi", k: 999 }),
    );
    expect(res.status).toBe(400);
  });

  test("timeline requires the search grant", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "capture")]);
    const res = await app.request("/api/knowledge/timeline");
    expect(res.status).toBe(403);
  });

  test("timeline never returns a title private to another principal", async () => {
    // Catalog contains a private secret title. Caller PRINCIPAL is not on
    // its visibleTo list — the plane filters by principalId the route passes.
    const { app } = buildApp([grant(PRINCIPAL, "search")], {
      timelineCatalog: TIMELINE_CATALOG,
      principalId: PRINCIPAL,
    });
    const res = await app.request("/api/knowledge/timeline");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: TimelineEvent[] };
    expect(body.events.map((e) => e.title)).toEqual([PUBLIC_TITLE]);
    expect(body.events.map((e) => e.title)).not.toContain(SECRET_TITLE);
  });

  test("timeline returns a private title only to the allowed principal", async () => {
    const { app } = buildApp([grant("alice", "search")], {
      timelineCatalog: TIMELINE_CATALOG,
      principalId: "alice",
    });
    const res = await app.request("/api/knowledge/timeline");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: TimelineEvent[] };
    expect(body.events.map((e) => e.title).sort()).toEqual(
      [PUBLIC_TITLE, SECRET_TITLE].sort(),
    );
  });

  test("timeline scopes by the caller's principal (different principal → different events)", async () => {
    const { app: appP1 } = buildApp([grant(PRINCIPAL, "search")], {
      timelineCatalog: TIMELINE_CATALOG,
      principalId: PRINCIPAL,
    });
    const { app: appOther } = buildApp([grant(OTHER, "search")], {
      timelineCatalog: TIMELINE_CATALOG,
      principalId: OTHER,
    });
    const titles = async (app: Hono<TenantEnv>) => {
      const res = await app.request("/api/knowledge/timeline");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: TimelineEvent[] };
      return body.events.map((e) => e.title);
    };
    expect(await titles(appP1)).toEqual([PUBLIC_TITLE]);
    expect(await titles(appOther)).toEqual([PUBLIC_TITLE]);
    expect(await titles(appP1)).not.toContain(SECRET_TITLE);
    expect(await titles(appOther)).not.toContain(SECRET_TITLE);
  });

  test("capture is rejected (401) when no principal is on the context", async () => {
    const app = buildAppWithoutPrincipal();
    const res = await app.request(
      "/api/knowledge/capture",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(401);
  });

  test("search is rejected (401) when no principal is on the context", async () => {
    const app = buildAppWithoutPrincipal();
    const res = await app.request(
      "/api/knowledge/search",
      jsonPost({ query: "hello" }),
    );
    expect(res.status).toBe(401);
  });

  test("timeline is rejected (401) when no principal is on the context", async () => {
    const app = buildAppWithoutPrincipal();
    const res = await app.request("/api/knowledge/timeline");
    expect(res.status).toBe(401);
  });
});
