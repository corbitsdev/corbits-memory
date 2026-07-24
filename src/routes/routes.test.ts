import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createInMemoryGrantStore } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";

import { CaptureLog } from "../capture-log.ts";
import type { KnowledgePlane } from "../knowledge.ts";
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

// A knowledge plane stub that records captures and returns a fixed result.
function stubPlane() {
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
    close: async () => {},
  };
  return { plane, captured };
}

function buildApp(grants: GrantRule[]) {
  const { plane, captured } = stubPlane();
  const grantConfig = {
    grantStore: createInMemoryGrantStore(grants),
    conditionRegistry: {},
  };
  const deps: RouteDeps = {
    knowledge: plane,
    captureLog: new CaptureLog(),
    grants: grantConfig,
    requireGrant: createRequireGrant(grantConfig),
  };

  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    // Interchange's tenant middleware puts both principal + tenant on the
    // context; requireGrant reads tenant.id, our caller() reads principal.
    c.set("principal", {
      id: PRINCIPAL,
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

  test("capture is rejected (403) for a search-only principal", async () => {
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
});
