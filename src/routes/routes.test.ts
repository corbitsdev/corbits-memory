import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createInMemoryGrantStore } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";

import type { Memory, TimelineEvent } from "../memory.ts";
import { MemoryError } from "../memory.ts";
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

// "run-principal" mirrors RUN_PRINCIPAL in the callerResolver describe
// blocks below — a document/version created by a resolved machine caller.
const RETENTION_DOCS: Record<string, { ownerId: string }> = {
  "doc-mine": { ownerId: PRINCIPAL },
  "doc-alice": { ownerId: "alice" },
  "doc-run-owned": { ownerId: "run-principal" },
};

const RETENTION_VERSIONS: Record<
  string,
  { ownerId: string; documentId: string }
> = {
  "ver-mine": { ownerId: PRINCIPAL, documentId: "doc-mine" },
  "ver-alice": { ownerId: "alice", documentId: "doc-alice" },
  "ver-run-owned": { ownerId: "run-principal", documentId: "doc-run-owned" },
};

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
  const tombstoned: string[] = [];
  const purged: string[] = [];
  const retentionClassChanges: Array<{ versionId: string; retentionClass: string }> = [];
  const catalog = opts?.timelineCatalog ?? [];
  const plane: Memory = {
    capabilities: { embeddingsConfigured: true },
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
    // Mirrors memory.ts's real ownership gate — a caller who can only see a
    // document via a share grant is not its creator and gets refused.
    tombstoneDocument: async ({ documentId, principalId }) => {
      const doc = RETENTION_DOCS[documentId];
      if (!doc) throw new MemoryError(404, "document not found");
      if (doc.ownerId !== principalId) {
        throw new MemoryError(403, "only the document's creator may forget it");
      }
      tombstoned.push(documentId);
      return { versions: 1 };
    },
    hardDeleteDocument: async ({ documentId, principalId }) => {
      const doc = RETENTION_DOCS[documentId];
      if (!doc) throw new MemoryError(404, "document not found");
      if (doc.ownerId !== principalId) {
        throw new MemoryError(403, "only the document's creator may purge it");
      }
      purged.push(documentId);
      return { deleted: true };
    },
    setRetentionClass: async ({ versionId, principalId, retentionClass }) => {
      const version = RETENTION_VERSIONS[versionId];
      if (!version) throw new MemoryError(404, "version not found");
      if (version.ownerId !== principalId) {
        throw new MemoryError(
          403,
          "only the version's creator may change its retention class",
        );
      }
      retentionClassChanges.push({ versionId, retentionClass });
      return { versionId, documentId: version.documentId, status: "active" };
    },
    close: async () => {},
  };
  return {
    plane,
    added,
    searched,
    tombstoned,
    purged,
    retentionClassChanges,
  };
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
  const { plane, added, searched, tombstoned, purged, retentionClassChanges } =
    stubPlane(opts);
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
  return { app, added, searched, tombstoned, purged, retentionClassChanges };
}

/**
 * A plane stub for the machine-caller tests that records `tenantId`/
 * `principalId` on every verb (not just `add`) — the shared `stubPlane`
 * above deliberately omits them from `search`/`list` to keep its existing
 * `.toEqual` assertions exact, so this is a separate stub rather than a
 * change to that one.
 */
function stubMachinePlane(opts?: {
  timelineCatalog?: Array<
    TimelineEvent & { visibleTo: readonly string[] | "tenant" }
  >;
}) {
  const added: { title: string; tenantId: string; principalId: string }[] = [];
  const searched: { tenantId: string; principalId: string; query: string }[] =
    [];
  const fed: { tenantId: string; principalId: string }[] = [];
  const tombstoned: string[] = [];
  const purged: string[] = [];
  const retentionClassChanges: Array<{ versionId: string; retentionClass: string }> = [];
  const catalog = opts?.timelineCatalog ?? [];
  const plane: Memory = {
    capabilities: { embeddingsConfigured: true },
    search: async (p) => {
      searched.push({
        tenantId: p.tenantId,
        principalId: p.principalId,
        query: p.query,
      });
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
    feed: async (p) => {
      fed.push({ tenantId: p.tenantId, principalId: p.principalId });
      return { entries: [], nextCursor: null };
    },
    // Same creator-check semantics as stubPlane, for a resolved machine
    // caller retiring the memory it created itself (CL-6288 review).
    tombstoneDocument: async ({ documentId, principalId }) => {
      const doc = RETENTION_DOCS[documentId];
      if (!doc) throw new MemoryError(404, "document not found");
      if (doc.ownerId !== principalId) {
        throw new MemoryError(403, "only the document's creator may forget it");
      }
      tombstoned.push(documentId);
      return { versions: 1 };
    },
    hardDeleteDocument: async ({ documentId, principalId }) => {
      const doc = RETENTION_DOCS[documentId];
      if (!doc) throw new MemoryError(404, "document not found");
      if (doc.ownerId !== principalId) {
        throw new MemoryError(403, "only the document's creator may purge it");
      }
      purged.push(documentId);
      return { deleted: true };
    },
    setRetentionClass: async ({ versionId, principalId, retentionClass }) => {
      const version = RETENTION_VERSIONS[versionId];
      if (!version) throw new MemoryError(404, "version not found");
      if (version.ownerId !== principalId) {
        throw new MemoryError(
          403,
          "only the version's creator may change its retention class",
        );
      }
      retentionClassChanges.push({ versionId, retentionClass });
      return { versionId, documentId: version.documentId, status: "active" };
    },
    close: async () => {},
  };
  return { plane, added, searched, fed, tombstoned, purged, retentionClassChanges };
}

function buildAppWithCallerResolver(
  grants: GrantRule[],
  callerResolver: RouteDeps["callerResolver"],
  opts?: {
    timelineCatalog?: Array<
      TimelineEvent & { visibleTo: readonly string[] | "tenant" }
    >;
  },
) {
  const { plane, added, searched, fed, tombstoned, purged, retentionClassChanges } =
    stubMachinePlane(opts);
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
  return { app, added, searched, fed, tombstoned, purged, retentionClassChanges };
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

describe("memory HTTP routes — retention (CL-6288)", () => {
  test("forget tombstones the caller's own document", async () => {
    const { app, tombstoned } = buildApp([grant(PRINCIPAL, "forget")]);
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-mine/forget",
      jsonPost({}),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documentId: string; versions: number };
    expect(body).toEqual({ documentId: "doc-mine", versions: 1 });
    expect(tombstoned).toEqual(["doc-mine"]);
  });

  test("forget without the memory:forget grant is 403 (search does not authorize it)", async () => {
    const { app, tombstoned } = buildApp([
      grant(PRINCIPAL, "search"),
      grant(PRINCIPAL, "add"),
    ]);
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-mine/forget",
      jsonPost({}),
    );
    expect(res.status).toBe(403);
    expect(tombstoned).toHaveLength(0);
  });

  test("forget is refused for a document owned by another principal, even with the forget grant", async () => {
    // The mirror of CL-6286's cross-tenant test: PRINCIPAL can call forget
    // (has the grant) but doc-alice belongs to "alice" — visibility via a
    // share is not the same as ownership.
    const { app, tombstoned } = buildApp([grant(PRINCIPAL, "forget")]);
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-alice/forget",
      jsonPost({}),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("creator");
    expect(tombstoned).toHaveLength(0);
  });

  test("forget 404s for an unknown document", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "forget")]);
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-unknown/forget",
      jsonPost({}),
    );
    expect(res.status).toBe(404);
  });

  test("purge hard-deletes the caller's own document", async () => {
    const { app, purged } = buildApp([grant(PRINCIPAL, "purge")]);
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-mine/purge",
      jsonPost({}),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documentId: string; deleted: boolean };
    expect(body).toEqual({ documentId: "doc-mine", deleted: true });
    expect(purged).toEqual(["doc-mine"]);
  });

  test("purge without the memory:purge grant is 403 — the forget grant does not authorize purge", async () => {
    const { app, purged } = buildApp([grant(PRINCIPAL, "forget")]);
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-mine/purge",
      jsonPost({}),
    );
    expect(res.status).toBe(403);
    expect(purged).toHaveLength(0);
  });

  test("purge is refused for a document owned by another principal", async () => {
    const { app, purged } = buildApp([grant(PRINCIPAL, "purge")]);
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-alice/purge",
      jsonPost({}),
    );
    expect(res.status).toBe(403);
    expect(purged).toHaveLength(0);
  });

  test("forget and purge are distinct routes — calling forget never hard-deletes", async () => {
    const { app, tombstoned, purged } = buildApp([
      grant(PRINCIPAL, "forget"),
      grant(PRINCIPAL, "purge"),
    ]);
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-mine/forget",
      jsonPost({}),
    );
    expect(res.status).toBe(200);
    expect(tombstoned).toEqual(["doc-mine"]);
    expect(purged).toHaveLength(0);
  });

  test("retention-class updates the version for its creator", async () => {
    const { app, retentionClassChanges } = buildApp([
      grant(PRINCIPAL, "forget"),
    ]);
    const res = await app.request(
      "/api/tenants/t1/memory/versions/ver-mine/retention-class",
      jsonPost({ retention_class: "durable" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versionId: string; status: string };
    expect(body.versionId).toBe("ver-mine");
    expect(retentionClassChanges).toEqual([
      { versionId: "ver-mine", retentionClass: "durable" },
    ]);
  });

  test("retention-class rejects an invalid retention_class value (400)", async () => {
    const { app } = buildApp([grant(PRINCIPAL, "forget")]);
    const res = await app.request(
      "/api/tenants/t1/memory/versions/ver-mine/retention-class",
      jsonPost({ retention_class: "nonsense" }),
    );
    expect(res.status).toBe(400);
  });

  test("retention-class is refused for a version owned by another principal", async () => {
    const { app, retentionClassChanges } = buildApp([
      grant(PRINCIPAL, "forget"),
    ]);
    const res = await app.request(
      "/api/tenants/t1/memory/versions/ver-alice/retention-class",
      jsonPost({ retention_class: "ephemeral" }),
    );
    expect(res.status).toBe(403);
    expect(retentionClassChanges).toHaveLength(0);
  });

  test("missing principal on forget is 401", async () => {
    const app = buildAppWithoutPrincipal();
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-mine/forget",
      jsonPost({}),
    );
    expect(res.status).toBe(401);
  });

  test("forget rejects a whitespace-only documentId (400, never reaching the plane)", async () => {
    const { app, tombstoned } = buildApp([grant(PRINCIPAL, "forget")]);
    const res = await app.request(
      "/api/tenants/t1/memory/documents/%20/forget",
      jsonPost({}),
    );
    expect(res.status).toBe(400);
    expect(tombstoned).toHaveLength(0);
  });

  test("purge rejects a whitespace-only documentId (400, never reaching the plane)", async () => {
    const { app, purged } = buildApp([grant(PRINCIPAL, "purge")]);
    const res = await app.request(
      "/api/tenants/t1/memory/documents/%20/purge",
      jsonPost({}),
    );
    expect(res.status).toBe(400);
    expect(purged).toHaveLength(0);
  });

  test("retention-class rejects a whitespace-only versionId (400, never reaching the plane)", async () => {
    const { app, retentionClassChanges } = buildApp([
      grant(PRINCIPAL, "forget"),
    ]);
    const res = await app.request(
      "/api/tenants/t1/memory/versions/%20/retention-class",
      jsonPost({ retention_class: "durable" }),
    );
    expect(res.status).toBe(400);
    expect(retentionClassChanges).toHaveLength(0);
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

  // The read paths matter more than `add` here: a bug on these means reading
  // ANOTHER TENANT'S memories, not just misattributing a write.

  test("search threads the resolved tenant/principal through to the plane, ignoring the URL's :tenantId", async () => {
    const { app, searched } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "search")],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    // The path names a DIFFERENT tenant than the resolved caller's.
    const res = await app.request(
      "/api/tenants/tenant-in-url-not-resolved/memory/search",
      jsonPost({ query: "hello" }),
    );
    expect(res.status).toBe(200);
    expect(searched).toEqual([
      { tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL, query: "hello" },
    ]);
  });

  test("search requires the search grant for the resolved caller (403)", async () => {
    const { app, searched } = buildAppWithCallerResolver(
      [],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request(
      "/api/tenants/t1/memory/search",
      jsonPost({ query: "hello" }),
    );
    expect(res.status).toBe(403);
    expect(searched).toHaveLength(0);
  });

  test("list returns only the resolved tenant's events, never another tenant's, regardless of the URL's :tenantId", async () => {
    const OTHER_TENANT = "tenant-other";
    const catalog: Array<TimelineEvent & { visibleTo: readonly string[] | "tenant" }> = [
      {
        at: "2026-01-02T00:00:00.000Z",
        title: "run tenant's note",
        source: "mcp",
        tenantId: RUN_TENANT,
        principalId: RUN_PRINCIPAL,
        visibleTo: "tenant",
      },
      {
        at: "2026-01-01T00:00:00.000Z",
        title: "a different tenant's note",
        source: "mcp",
        tenantId: OTHER_TENANT,
        principalId: "someone-else",
        visibleTo: "tenant",
      },
    ];
    const { app } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "search")],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
      { timelineCatalog: catalog },
    );
    // The path names the OTHER tenant; the resolved caller must still only
    // ever see its own tenant's events.
    const res = await app.request(`/api/tenants/${OTHER_TENANT}/memory/list`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: TimelineEvent[] };
    expect(body.events.map((e) => e.title)).toEqual(["run tenant's note"]);
  });

  test("list requires the search grant for the resolved caller (403)", async () => {
    const { app } = buildAppWithCallerResolver(
      [],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request("/api/tenants/t1/memory/list");
    expect(res.status).toBe(403);
  });

  test("feed threads the resolved tenant/principal through to the plane, ignoring the URL's :tenantId", async () => {
    const { app, fed } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "search")],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request(
      "/api/tenants/tenant-in-url-not-resolved/memory/feed",
    );
    expect(res.status).toBe(200);
    expect(fed).toEqual([{ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }]);
  });

  test("feed requires the search grant for the resolved caller (403)", async () => {
    const { app, fed } = buildAppWithCallerResolver(
      [],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request("/api/tenants/t1/memory/feed");
    expect(res.status).toBe(403);
    expect(fed).toHaveLength(0);
  });

  // The most likely real-world caller of forget/purge: a workflow-run child
  // (resolved via callerResolver, CL-6286) retiring memory it wrote itself.
  // If the resolver's principalId ever drifted from created_by_principal_id
  // (different derivation, casing, run-address vs principal-address), this
  // is exactly what would start 403ing in production instead of a test.

  test("forget tombstones a document the resolved run's own principal created", async () => {
    const { app, tombstoned } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "forget")],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-run-owned/forget",
      jsonPost({}),
    );
    expect(res.status).toBe(200);
    expect(tombstoned).toEqual(["doc-run-owned"]);
  });

  test("purge hard-deletes a document the resolved run's own principal created", async () => {
    const { app, purged } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "purge")],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-run-owned/purge",
      jsonPost({}),
    );
    expect(res.status).toBe(200);
    expect(purged).toEqual(["doc-run-owned"]);
  });

  test("retention-class updates a version the resolved run's own principal created", async () => {
    const { app, retentionClassChanges } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "forget")],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request(
      "/api/tenants/t1/memory/versions/ver-run-owned/retention-class",
      jsonPost({ retention_class: "durable" }),
    );
    expect(res.status).toBe(200);
    expect(retentionClassChanges).toEqual([
      { versionId: "ver-run-owned", retentionClass: "durable" },
    ]);
  });

  test("forget is still refused for a resolved run caller that is not the creator, even with the grant", async () => {
    const { app, tombstoned } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "forget")],
      () => ({ tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL }),
    );
    const res = await app.request(
      "/api/tenants/t1/memory/documents/doc-alice/forget",
      jsonPost({}),
    );
    expect(res.status).toBe(403);
    expect(tombstoned).toHaveLength(0);
  });
});

describe("memory HTTP routes — resolver trust-boundary and row-fabrication contract", () => {
  const RUN_TENANT = "tenant-run";
  const RUN_PRINCIPAL = "run-principal";

  test("a resolver that throws does not authorize the request (fails closed, no leaked message)", async () => {
    const { app, added } = buildAppWithCallerResolver(
      [grant(RUN_PRINCIPAL, "add")],
      () => {
        throw new Error("db connection string with secret=abc123");
      },
    );
    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret=abc123");
    expect(added).toHaveLength(0);
  });

  test.each([
    ["empty-string", { tenantId: "", principalId: "" }],
    // "string >= 1" would be a LENGTH constraint only -- " " has length 1
    // and would pass it, seating a whitespace-only scope wearing the same
    // costume as the empty-string case above. This is the regression guard
    // for that boundary (same bug class PR #34 fixed in optionalEnv).
    ["whitespace-only", { tenantId: " ", principalId: "\t\n" }],
  ] as const)(
    "a resolver returning a %s identity is rejected, not seated as a garbage scope",
    async (_label, resolved) => {
      // A grant that would (wrongly) authorize the malformed principal if
      // the identity were ever seated — proving rejection happens before
      // grantGuard, not that no grant happened to match.
      const { app, added } = buildAppWithCallerResolver(
        [grant(resolved.principalId, "add")],
        () => resolved,
      );
      const res = await app.request(
        "/api/tenants/t1/memory/add",
        jsonPost({ title: "t", text: "body" }),
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_resolved_caller");
      expect(added).toHaveLength(0);
    },
  );

  /**
   * `principalRowFor`/`tenantRowFor` (deps.ts) fabricate `PrincipalRow`/
   * `TenantRow` with placeholder fields for everything Interchange's
   * `requireGrant`/`authorize` doesn't read. That's only safe as long as
   * `authorize()` (and `caller()`, in-package) never read anything but
   * `.id` / `.tenantId`. A Proxy that throws on any other property access
   * turns a future Interchange version quietly reading a fabricated field
   * (`status`, `kind`, `parentId`, `config`, ...) into a loud test failure
   * instead of silent authorization on fiction.
   */
  test("requireGrant/authorize and caller() never read a fabricated row field beyond .id / .tenantId", async () => {
    function canary<T extends object>(row: T, allowed: (keyof T)[]): T {
      return new Proxy(row, {
        get(target, prop, receiver) {
          if (
            typeof prop === "string" &&
            !allowed.includes(prop as keyof T)
          ) {
            throw new Error(
              `unexpected field access on a synthesized row: ${prop}`,
            );
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }

    const canaryPrincipal = canary(
      {
        id: RUN_PRINCIPAL,
        tenantId: RUN_TENANT,
        kind: "agent" as const,
        refId: RUN_PRINCIPAL,
        status: "active" as const,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      ["id", "tenantId"],
    );
    const canaryTenant = canary(
      {
        id: RUN_TENANT,
        name: RUN_TENANT,
        slug: RUN_TENANT,
        domain: "",
        parentId: null,
        config: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      ["id"],
    );

    const { plane, added } = stubMachinePlane();
    const grantConfig = {
      grantStore: createInMemoryGrantStore([grant(RUN_PRINCIPAL, "add")]),
      conditionRegistry: {},
    };
    const deps: RouteDeps = {
      memory: plane,
      grants: grantConfig,
      requireGrant: createRequireGrant(grantConfig),
    };
    const app = new Hono<TenantEnv>();
    // Seat the canary rows directly, bypassing resolveCaller/callerResolver:
    // this isolates the contract under test (does anything downstream of
    // context read more than .id / .tenantId) from resolveCaller's own
    // fabrication, which is exercised separately above.
    app.use("*", async (c, next) => {
      c.set("principal", canaryPrincipal);
      c.set("tenant", canaryTenant);
      await next();
    });
    registerMemoryRoutes(app, deps);

    const res = await app.request(
      "/api/tenants/t1/memory/add",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(200);
    expect(added).toEqual([
      { title: "t", tenantId: RUN_TENANT, principalId: RUN_PRINCIPAL },
    ]);
  });
});
