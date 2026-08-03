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

// A knowledge plane stub that records adds and returns fixed results.
// Recent applies a simple ACL model so route tests can prove the route
// never invents titles and always scopes by the caller's principal.
function stubPlane(opts?: {
  timelineCatalog?: Array<
    TimelineEvent & { visibleTo: readonly string[] | "tenant" }
  >;
  askImpl?: KnowledgePlane["ask"];
}) {
  const added: { title: string; tenantId: string; principalId: string }[] = [];
  const searched: Array<
    Pick<
      Parameters<KnowledgePlane["find"]>[0],
      "kinds" | "entityIds" | "limit"
    >
  > = [];
  const catalog = opts?.timelineCatalog ?? [];
  const plane: KnowledgePlane = {
    find: async (p) => {
      searched.push({ kinds: p.kinds, entityIds: p.entityIds, limit: p.limit });
      return { items: [], evidence: "none" };
    },
    ask:
      opts?.askImpl ??
      (async () => ({ text: "stub answer", citations: [], evidence: "none" })),
    add: async (p) => {
      added.push({
        title: p.content?.title ?? "",
        tenantId: p.tenantId,
        principalId: p.principalId,
      });
      return { documentId: "doc-stub" };
    },
    recent: async (p) => {
      return catalog
        .filter(
          (e) =>
            e.tenantId === p.tenantId &&
            (e.visibleTo === "tenant" || e.visibleTo.includes(p.principalId)),
        )
        .map(({ visibleTo: _v, ...event }) => event);
    },
    remember: async () => {},
    recall: async () => [],
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
    askImpl?: KnowledgePlane["ask"];
  },
) {
  const { plane, added, searched } = stubPlane(opts);
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
  return { app, added, searched };
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

const RECENT_CATALOG: Array<
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
  test("add with the add grant writes under the caller's scope", async () => {
    const { app, added } = buildApp([
      grant(PRINCIPAL, "add"),
      grant(PRINCIPAL, "find"),
    ]);
    const res = await app.request(
      "/api/knowledge/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documentId: string };
    expect(body.documentId).toBe("doc-stub");
    expect(added).toEqual([
      { title: "t", tenantId: TENANT, principalId: PRINCIPAL },
    ]);
  });

  test("add without the add grant is 403", async () => {
    const { app, added } = buildApp([grant(PRINCIPAL, "find")]);
    const res = await app.request(
      "/api/knowledge/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(403);
    expect(added).toHaveLength(0);
  });

  test("legacy capture grant does not authorize add", async () => {
    const { app, added } = buildApp([grant(PRINCIPAL, "capture")]);
    const res = await app.request(
      "/api/knowledge/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(403);
    expect(added).toHaveLength(0);
  });

  test("add validates the body (400 on missing text)", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "add")]);
    const res = await app.request(
      "/api/knowledge/add",
      jsonPost({ title: "t" }),
    );
    expect(res.status).toBe(400);
  });

  test("find with the find grant returns a result", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "find")]);
    const res = await app.request(
      "/api/knowledge/find",
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

  test("find requires the find grant", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "add")]);
    const res = await app.request(
      "/api/knowledge/find",
      jsonPost({ query: "hi" }),
    );
    expect(res.status).toBe(403);
  });

  test("legacy search grant does not authorize find", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/knowledge/find",
      jsonPost({ query: "hi" }),
    );
    expect(res.status).toBe(403);
  });

  test("find rejects out-of-range limit (400)", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "find")]);
    const res = await app.request(
      "/api/knowledge/find",
      jsonPost({ query: "hi", limit: 999 }),
    );
    expect(res.status).toBe(400);
  });

  test("find threads kinds and entity_ids through to the plane", async () => {
    const { app, searched } = buildApp([grant(PRINCIPAL, "find")]);
    const res = await app.request(
      "/api/knowledge/find",
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

  test("find with no kinds/entity_ids leaves them unset on the plane call", async () => {
    const { app, searched } = buildApp([grant(PRINCIPAL, "find")]);
    const res = await app.request(
      "/api/knowledge/find",
      jsonPost({ query: "hello" }),
    );
    expect(res.status).toBe(200);
    expect(searched).toEqual([
      { kinds: undefined, entityIds: undefined, limit: undefined },
    ]);
  });

  test("find rejects a non-string-array kinds (400)", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "find")]);
    const res = await app.request(
      "/api/knowledge/find",
      jsonPost({ query: "hi", kinds: [1, 2] }),
    );
    expect(res.status).toBe(400);
  });

  // The route does not collapse [] to absent — hybridSearch treats an empty
  // array and an absent field the same way (see services/search.ts).
  test("find passes an empty kinds/entity_ids array through unchanged", async () => {
    const { app, searched } = buildApp([grant(PRINCIPAL, "find")]);
    const res = await app.request(
      "/api/knowledge/find",
      jsonPost({ query: "hello", kinds: [], entity_ids: [] }),
    );
    expect(res.status).toBe(200);
    expect(searched).toEqual([
      { kinds: [], entityIds: [], limit: undefined },
    ]);
  });

  test("ask requires the find grant (same as find)", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "add")]);
    const res = await app.request(
      "/api/knowledge/ask",
      jsonPost({ query: "what?" }),
    );
    expect(res.status).toBe(403);
  });

  test("ask with the find grant returns a grounded answer", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "find")]);
    const res = await app.request(
      "/api/knowledge/ask",
      jsonPost({ query: "what?" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      text: string;
      citations: unknown[];
      evidence: string;
    };
    expect(body.text).toBe("stub answer");
    expect(body.citations).toEqual([]);
    expect(body.evidence).toBe("none");
  });

  test("recent requires the find grant", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "add")]);
    const res = await app.request("/api/knowledge/recent");
    expect(res.status).toBe(403);
  });

  test("recent never returns a title private to another principal", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "find")], {
      timelineCatalog: RECENT_CATALOG,
      principalId: PRINCIPAL,
    });
    const res = await app.request("/api/knowledge/recent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: TimelineEvent[] };
    expect(body.events.map((e) => e.title)).toEqual([PUBLIC_TITLE]);
    expect(body.events.map((e) => e.title)).not.toContain(SECRET_TITLE);
  });

  test("recent returns a private title only to the allowed principal", async () => {
    const { app } = buildApp([grant("alice", "find")], {
      timelineCatalog: RECENT_CATALOG,
      principalId: "alice",
    });
    const res = await app.request("/api/knowledge/recent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: TimelineEvent[] };
    expect(body.events.map((e) => e.title).sort()).toEqual(
      [PUBLIC_TITLE, SECRET_TITLE].sort(),
    );
  });

  test("recent scopes by the caller's principal (different principal → different events)", async () => {
    const { app: appP1 } = buildApp([grant(PRINCIPAL, "find")], {
      timelineCatalog: RECENT_CATALOG,
      principalId: PRINCIPAL,
    });
    const { app: appOther } = buildApp([grant(OTHER, "find")], {
      timelineCatalog: RECENT_CATALOG,
      principalId: OTHER,
    });
    const titles = async (app: Hono<TenantEnv>) => {
      const res = await app.request("/api/knowledge/recent");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: TimelineEvent[] };
      return body.events.map((e) => e.title);
    };
    expect(await titles(appP1)).toEqual([PUBLIC_TITLE]);
    expect(await titles(appOther)).toEqual([PUBLIC_TITLE]);
    expect(await titles(appP1)).not.toContain(SECRET_TITLE);
    expect(await titles(appOther)).not.toContain(SECRET_TITLE);
  });

  test("old paths are not mounted (hard cutover, no fallback)", async () => {
    const { app } = buildApp([
      grant(PRINCIPAL, "add"),
      grant(PRINCIPAL, "find"),
      grant(PRINCIPAL, "capture"),
      grant(PRINCIPAL, "search"),
    ]);
    for (const path of [
      "/api/knowledge/capture",
      "/api/knowledge/search",
      "/api/knowledge/timeline",
    ]) {
      const method = path.endsWith("timeline") ? "GET" : "POST";
      const res = await app.request(
        path,
        method === "GET"
          ? undefined
          : jsonPost(
              path.includes("capture")
                ? { title: "t", text: "body" }
                : { query: "hi" },
            ),
      );
      expect(res.status).toBe(404);
    }
  });

  test("add is rejected (401) when no principal is on the context", async () => {
    const app = buildAppWithoutPrincipal();
    const res = await app.request(
      "/api/knowledge/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(401);
  });

  test("find is rejected (401) when no principal is on the context", async () => {
    const app = buildAppWithoutPrincipal();
    const res = await app.request(
      "/api/knowledge/find",
      jsonPost({ query: "hello" }),
    );
    expect(res.status).toBe(401);
  });

  test("ask is rejected (401) when no principal is on the context", async () => {
    const app = buildAppWithoutPrincipal();
    const res = await app.request(
      "/api/knowledge/ask",
      jsonPost({ query: "hello" }),
    );
    expect(res.status).toBe(401);
  });

  test("recent is rejected (401) when no principal is on the context", async () => {
    const app = buildAppWithoutPrincipal();
    const res = await app.request("/api/knowledge/recent");
    expect(res.status).toBe(401);
  });
});
