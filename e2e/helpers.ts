// Real-Postgres harness for the e2e/ suites. Each suite gets a fresh
// database on the server named by TEST_DATABASE_URL (any pgvector Postgres
// whose user can create databases, such as compose.yml's), with Interchange's control-plane tables and the memory
// migrations applied; `close` drops it.

import { type DBConfig, runMigrations } from "@intx/db";
import type { GrantRule, GrantStore } from "@intx/authz";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";
import postgres from "postgres";

import { createMemory, type Memory } from "../src/memory.ts";
import type { MemoryConfig } from "../src/mount-config.ts";
import { runMemoryMigrations } from "../src/migrations.ts";
import { createMemoryRoutes } from "../src/routes/mount.ts";

const FTS_LANGUAGE = "english";

/**
 * Gate for `describe.skipIf`: the suite skips when no server is configured,
 * except in CI, where a missing server fails the run instead.
 */
export function testDatabaseUrl(): string | undefined {
  const url = process.env["TEST_DATABASE_URL"];
  if (url === undefined && process.env["CI"] !== undefined) {
    throw new Error("TEST_DATABASE_URL is required in CI");
  }
  return url;
}

function dbConfigFromUrl(url: URL, database: string): DBConfig {
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

export type TestDb = {
  config: DBConfig;
  databaseUrl: string;
  sql: postgres.Sql;
  close: () => Promise<void>;
};

/** An empty database on the test server, with nothing migrated. */
export async function createEmptyDb(): Promise<TestDb> {
  const serverUrl = testDatabaseUrl();
  if (serverUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required for the e2e/ suites");
  }
  const url = new URL(serverUrl);
  const database = `memory_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(serverUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE "${database}"`);
  } catch (err) {
    await admin.end();
    throw err;
  }

  const dbUrl = new URL(url);
  dbUrl.pathname = `/${database}`;
  const sql = postgres(dbUrl.toString(), { max: 1, onnotice: () => undefined });
  return {
    config: dbConfigFromUrl(url, database),
    databaseUrl: dbUrl.toString(),
    sql,
    close: async () => {
      try {
        await sql.end();
      } finally {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await admin.end();
      }
    },
  };
}

/** A fresh database with Interchange's tables and the memory migrations. */
export async function createTestDb(): Promise<TestDb> {
  const db = await createEmptyDb();
  try {
    await runMigrations(db.config, { schema: "public" });
    await runMemoryMigrations(db.config, {
      schema: "public",
      ftsLanguage: FTS_LANGUAGE,
    });
  } catch (err) {
    await db.close();
    throw err;
  }
  return db;
}

/** Insert the tenant and principal rows memory's foreign keys point at. */
export async function seedPrincipal(
  db: TestDb,
  tenantId: string,
  principalId: string,
): Promise<void> {
  await db.sql`
    INSERT INTO public.tenant (id, name, slug, domain)
    VALUES (${tenantId}, ${tenantId}, ${tenantId}, ${`${tenantId}.test`})
    ON CONFLICT (id) DO NOTHING`;
  await db.sql`
    INSERT INTO public.principal (id, tenant_id, kind, ref_id, status)
    VALUES (${principalId}, ${tenantId}, 'user', ${principalId}, 'active')`;
}

/** Engine config for the test database: lexical-only, no reranker. */
export function testMemoryConfig(db: TestDb): MemoryConfig {
  return {
    memory: {
      databaseUrl: db.databaseUrl,
      dbPoolMax: 4,
      ftsLanguage: FTS_LANGUAGE,
      rerank: {
        baseUrl: undefined,
        model: undefined,
        apiKey: undefined,
        maxDocChars: undefined,
        timeoutMs: undefined,
      },
    },
  };
}

/** The engine-backed memory on the test database. */
export function createTestMemory(db: TestDb, grantStore: GrantStore): Memory {
  return createMemory({
    config: testMemoryConfig(db),
    grantStore,
    conditionRegistry: {},
  });
}

export function allow(principalId: string, action: string): GrantRule {
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

export type TestCaller = { tenantId: string; principalId: string };

/**
 * A host app with the memory routes mounted under the tenant tree. The
 * stand-in tenant middleware seats the caller named by the bearer token and
 * refuses a path naming another tenant, the way a hub's session middleware
 * would.
 */
export function createTestApp(opts: {
  memory: Memory;
  grantStore: GrantStore;
  callers: Record<string, TestCaller>;
}): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.use("/api/tenants/:tenantId/*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "");
    const found = token === undefined ? undefined : opts.callers[token];
    if (found === undefined) return c.json({ error: "unauthenticated" }, 401);
    if (c.req.param("tenantId") !== found.tenantId) {
      return c.json({ error: "wrong tenant" }, 403);
    }
    c.set("principal", {
      id: found.principalId,
      tenantId: found.tenantId,
      kind: "user",
      refId: found.principalId,
      status: "active",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    c.set("tenant", {
      id: found.tenantId,
      name: found.tenantId,
      slug: found.tenantId,
      domain: `${found.tenantId}.test`,
      parentId: null,
      config: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await next();
  });
  app.route(
    "/api/tenants/:tenantId/memory",
    createMemoryRoutes({
      memory: opts.memory,
      requireGrant: createRequireGrant({
        grantStore: opts.grantStore,
        conditionRegistry: {},
      }),
    }),
  );
  return app;
}

// A local HTTP server standing in for an embed or rerank endpoint. Each test
// sets `reply`; every request is recorded with its path, auth header and
// JSON body (both clients only send JSON).

export type StubRequest = {
  path: string;
  authorization: string | null;
  body: unknown;
};

export type HttpStub = {
  url: string;
  requests: StubRequest[];
  reply: (req: StubRequest) => Response | Promise<Response>;
  reset: () => void;
  stop: () => void;
};

const unconfigured = () => new Response("no reply configured", { status: 500 });

export function startHttpStub(): HttpStub {
  const stub: HttpStub = {
    url: "",
    requests: [],
    reply: unconfigured,
    reset: () => {
      stub.requests.length = 0;
      stub.reply = unconfigured;
    },
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const recorded: StubRequest = {
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        body: await req.json(),
      };
      stub.requests.push(recorded);
      return stub.reply(recorded);
    },
  });
  stub.url = server.url.href.replace(/\/$/, "");
  return stub;
}
