import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

import type { Memory } from "../src/memory.js";
import { createMemoryRoutes } from "../src/routes/mount.js";
import {
  allow,
  createTestDb,
  createTestMemory,
  seedPrincipal,
  testDatabaseUrl,
  type TestDb,
} from "./helpers.js";

describe.skipIf(testDatabaseUrl() === undefined)(
  "synthesized context rows",
  () => {
    let db: TestDb;
    let memory: Memory | undefined;

    beforeAll(async () => {
      db = await createTestDb();
      await seedPrincipal(db, "acme", "run");
    });

    afterAll(async () => {
      await memory?.close();
      await db?.close();
    });

    // The rows resolveCaller seats carry placeholder fields; this fails loudly
    // if authorization or the routes ever read one.
    test("requireGrant and the routes read only .id and .tenantId", async () => {
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
      const grantStore = createInMemoryGrantStore([allow("run", "add")]);
      memory = createTestMemory(db, grantStore);
      const app = new Hono<TenantEnv>();
      app.use("*", async (c, next) => {
        c.set(
          "principal",
          canary(
            {
              id: "run",
              tenantId: "acme",
              kind: "agent",
              refId: "run",
              status: "active",
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
            ["id", "tenantId"],
          ),
        );
        c.set(
          "tenant",
          canary(
            {
              id: "acme",
              name: "acme",
              slug: "acme",
              domain: "",
              parentId: null,
              config: null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
            ["id"],
          ),
        );
        await next();
      });
      app.route(
        "/api/tenants/:tenantId/memory",
        createMemoryRoutes({
          memory,
          requireGrant: createRequireGrant({
            grantStore,
            conditionRegistry: {},
          }),
        }),
      );
      const res = await app.request("/api/tenants/acme/memory/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "t", text: "body" }),
      });
      expect(res.status).toBe(200);
    });
  },
);
