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

describe.skipIf(testDatabaseUrl() === undefined)("add and search", () => {
  let db: TestDb;
  let memory: Memory | undefined;
  let app: Hono<TenantEnv>;

  beforeAll(async () => {
    db = await createTestDb();
    await seedPrincipal(db, "acme", "alice");
    await seedPrincipal(db, "globex", "bob");
    const grantStore = createInMemoryGrantStore([
      allow("alice", "add"),
      allow("alice", "search"),
      allow("bob", "add"),
      allow("bob", "search"),
    ]);
    memory = createTestMemory(db, grantStore);
    app = createTestApp({
      memory,
      grantStore,
      callers: {
        alice: { tenantId: "acme", principalId: "alice" },
        bob: { tenantId: "globex", principalId: "bob" },
      },
    });
  });

  afterAll(async () => {
    await memory?.close();
    await db?.close();
  });

  function post(token: string, tenantId: string, path: string, body: unknown) {
    return app.request(`/api/tenants/${tenantId}/memory${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  test("search ranks the most relevant added document first", async () => {
    const docs = [
      {
        title: "Staging deploys",
        text: "Staging deploys run from main. Every staging deploy is automatic after merge.",
      },
      {
        title: "Lunch menu",
        text: "Tacos on Tuesday, pizza on Friday, salad on Monday. Catering deploys to the staging lobby.",
      },
      { title: "Vacation policy", text: "Request vacation two weeks ahead." },
    ];
    for (const doc of docs) {
      const res = await post("alice", "acme", "/add", doc);
      expect(res.status).toBe(200);
    }

    const res = await post("alice", "acme", "/search", {
      query: "staging deploy",
    });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { title: string }[] };
    expect(items.map((i) => i.title)).toEqual([
      "Staging deploys",
      "Lunch menu",
    ]);
  });

  test("another tenant's search returns none of the first tenant's documents", async () => {
    const add = await post("alice", "acme", "/add", {
      title: "Quarterly roadmap",
      text: "The quarterly roadmap covers billing and onboarding.",
    });
    expect(add.status).toBe(200);

    async function titles(token: string, tenantId: string): Promise<string[]> {
      const res = await post(token, tenantId, "/search", {
        query: "quarterly roadmap",
      });
      expect(res.status).toBe(200);
      const { items } = (await res.json()) as { items: { title: string }[] };
      return items.map((i) => i.title);
    }

    expect(await titles("alice", "acme")).toContain("Quarterly roadmap");
    expect(await titles("bob", "globex")).toEqual([]);
  });
});
