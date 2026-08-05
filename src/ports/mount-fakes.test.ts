/**
 * Acceptance: a host can createMemory with only fakes and get working
 * add / search / list — proves the port boundary is real.
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import {
  createInMemoryGrantStore,
  type GrantRule,
} from "@intx/authz";

import {
  createFakeDocumentStore,
  createFakeSourceProvider,
  createMemory,
} from "../index.ts";

const TENANT = "tenant_fake";
const PRINCIPAL = "principal_fake";

function grant(action: string): GrantRule {
  return {
    id: `g-${action}`,
    resource: "memory",
    action,
    effect: "allow",
    origin: "role",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: PRINCIPAL,
  };
}

function appWithPrincipal() {
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
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
  return app;
}

describe("createMemory with fakes only", () => {
  it("add → search → list without Postgres or embed config", async () => {
    const store = createFakeDocumentStore();
    const sources = [
      createFakeSourceProvider("linear", [
        {
          adapter: "linear",
          externalRef: "CL-99",
          title: "live only issue",
          snippet: "should not appear until merge lands",
          score: 0.99,
          kind: "issue",
          citation: {
            adapter: "linear",
            external_ref: "CL-99",
            open: {
              type: "issue",
              id: "CL-99",
              url: "https://linear.app/x/issue/CL-99",
            },
          },
        },
      ]),
    ];
    const app = appWithPrincipal();
    const memory = createMemory({
      app,
      grantStore: createInMemoryGrantStore([
        grant("add"),
        grant("search"),
      ]),
      conditionRegistry: {},
      documentStore: store,
      sources,
    });

    const { documentId } = await memory.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: {
        title: "ports note",
        text: "DocumentStore override works end to end",
      },
    });
    expect(documentId).toMatch(/^fake_doc_/);

    const found = await memory.search({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "DocumentStore override",
      includeEvidence: true,
    });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.documentId).toBe(documentId);

    const listed = await memory.list({
      tenantId: TENANT,
      principalId: PRINCIPAL,
    });
    expect(listed.some((e) => e.title === "ports note")).toBe(true);

    const addRes = await app.request("/api/tenants/tenant_fake/memory/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "via http",
        text: "http path uses the same store",
      }),
    });
    expect(addRes.status).toBe(200);
    const addBody = (await addRes.json()) as { documentId: string };
    expect(addBody.documentId).toMatch(/^fake_doc_/);

    const searchRes = await app.request("/api/tenants/tenant_fake/memory/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "http path" }),
    });
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as {
      items: Array<{ documentId: string }>;
    };
    expect(
      searchBody.items.some((i) => i.documentId === addBody.documentId),
    ).toBe(true);

    await memory.close();
  });
});
