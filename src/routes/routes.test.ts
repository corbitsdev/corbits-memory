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
const TENANT = "t1";

// A knowledge plane stub that records captures and returns fixed results.
function stubPlane(opts?: {
  timeline?: TimelineEvent[] | ((p: { principalId: string; tenantId: string }) => TimelineEvent[]);
}) {
  const captured: { title: string; tenantId: string; principalId: string }[] =
    [];
  const plane: KnowledgePlane = {
    search: async () => ({ hits: [], evidence: "none" }),
    capture: async (p) => {
      captured.push({
        title: p.title,
        tenantId: p.tenantId,
        principalId: p.principalId,
      });
    },
    timeline: async (p) => {
      if (typeof opts?.timeline === "function") return opts.timeline(p);
      return opts?.timeline ?? [];
    },
    close: async () => {},
  };
  return { plane, captured };
}

function buildApp(
  grants: GrantRule[],
  opts?: {
    timeline?: TimelineEvent[] | ((p: { principalId: string; tenantId: string }) => TimelineEvent[]);
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

const jsonPost = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

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
    const { app } = buildApp([grant(PRINCIPAL, "search")]);
    const res = await app.request(
      "/api/knowledge/capture",
      jsonPost({ title: "t", text: "body" }),
    );
    expect(res.status).toBe(403);
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

  test("timeline returns only events the plane surfaces for the caller", async () => {
    // The plane is the ACL boundary: a blocked/private title must never be in
    // the events the plane returns. The route must not re-add or leak them.
    const visible: TimelineEvent = {
      at: "2026-01-01T00:00:00.000Z",
      title: "team standup notes",
      source: "mcp",
      tenantId: TENANT,
      principalId: "alice",
    };
    const { app } = buildApp([grant(PRINCIPAL, "search")], {
      timeline: [visible],
    });
    const res = await app.request("/api/knowledge/timeline");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: TimelineEvent[] };
    expect(body.events).toEqual([visible]);
    expect(body.events.map((e) => e.title)).not.toContain(
      "Q3 layoffs — draft list",
    );
  });

  test("timeline passes the caller's principal and tenant to the plane", async () => {
    let seen: { principalId: string; tenantId: string } | undefined;
    const { app } = buildApp([grant(PRINCIPAL, "search")], {
      timeline: (p) => {
        seen = p;
        return [];
      },
    });
    const res = await app.request("/api/knowledge/timeline");
    expect(res.status).toBe(200);
    expect(seen).toEqual({ principalId: PRINCIPAL, tenantId: TENANT });
  });
});
