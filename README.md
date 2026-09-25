# @corbits/memory

[![npm](https://img.shields.io/npm/v/@corbits/memory.svg)](https://www.npmjs.com/package/@corbits/memory) [![License: LGPL-2.1](https://img.shields.io/badge/license-LGPL--2.1-green.svg)](https://github.com/corbitsdev/corbits-memory/blob/main/LICENSE)

Hybrid semantic and full-text document memory in Postgres with pgvector, with optional embedding and rerank endpoints. A Corbits hub module: it mounts Hono routes on `@intx/hub-api` that check Interchange grants (permissions a principal, a user or agent account, holds on a resource), and ships agent tools for the sidecar, the Interchange agent runtime.

## Why @corbits/memory?

1. **One store for people and agents.** Users add documents through the tenant routes, and deployed agents read and write the same store through run-scoped routes and a sidecar tool pack.
2. **Access follows grants.** Each document carries access tags. A caller sees a document only when a grant covers one of its tags, and the creator always sees their own.
3. **Search degrades instead of failing.** With no embedding endpoint, or when one is down, search falls back to Postgres full-text search and says so in a `degraded` field.
4. **Migrations that replay safely.** Every SQL file is idempotent, so running the migrations again is a no-op.

It does not generate answers: inference stays with the host, which calls `search` and passes the results to its own model.

## Install

```bash
bun add @corbits/memory \
  @intx/agent @intx/authz @intx/db @intx/hub-api @intx/log @intx/types @intx/workflow \
  drizzle-orm hono hono-openapi postgres
```

Postgres needs the pgvector extension.

## Quickstart

With `DATABASE_URL` pointing at a hub database that has run `runMemoryMigrations` (see [Using with Interchange](#using-with-interchange)):

```ts
import { createMemory, loadMemoryConfig } from "@corbits/memory";

const memory = createMemory({ config: loadMemoryConfig() });

await memory.add({
  tenantId: "acme",
  principalId: "alice",
  content: { title: "Deploys", text: "Staging deploys run from main." },
});
console.log(
  await memory.search({
    tenantId: "acme",
    principalId: "alice",
    query: "staging",
  }),
);
await memory.close();
```

`acme` and `alice` must be a tenant and principal in the hub. The search returns the document just added.

## Where it fits

[Interchange](https://github.com/faremeter/interchange) runs AI agents as principals: accounts with their own identity, permissions and credentials. Its hub is the multi-tenant control plane that holds tenants, principals and grants (permissions a principal holds on a resource); its sidecar is the agent runtime.

- **Runs in:** the hub, as routes on its Hono app and tables in its Postgres (`memory` schema).
- **Plugs into:** [`@intx/hub-api`](https://github.com/faremeter/interchange/tree/main/packages/hub-api) routes and grants, [`@intx/db`](https://github.com/faremeter/interchange/tree/main/packages/db) (its `DBConfig`, and its `tenant` and `principal` tables as foreign-key targets), [`@intx/agent`](https://github.com/faremeter/interchange/tree/main/packages/agent) tools on the sidecar, and [`@intx/workflow`](https://github.com/faremeter/interchange/tree/main/packages/workflow) for the resident distiller.
- **Pairs with:** [`@corbits/embedding`](https://github.com/corbitsdev/corbits-embedding) and [`@corbits/reranking`](https://github.com/corbitsdev/corbits-reranking) endpoints, [`@corbits/agent-token`](https://github.com/corbitsdev/corbits-agent-token) for agent bearer tokens, and [`@corbits/cron`](https://github.com/corbitsdev/corbits-cron) to tick the distiller.

## Reference

### `createMemory(options)`

| Option              | Type                | What the host provides                                                                                     |
| ------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `config`            | `MemoryConfig`      | Database and endpoint settings, usually from `loadMemoryConfig()`. Required unless `documentStore` is set. |
| `documentStore`     | `DocumentStore`     | Optional. A custom storage backend in place of the Postgres engine.                                        |
| `grantStore`        | `GrantStore`        | Optional. The hub's grant store. Without it, search and list return only the caller's own documents.       |
| `conditionRegistry` | `ConditionRegistry` | Optional. The hub's condition registry for conditional grants.                                             |
| `textExtractor`     | `TextExtractor`     | Optional. Turns `add({ file })` bytes into text; without it, only `add({ content })` is served.            |

The returned `Memory` has `add`, `search` and `list`, which take the caller's `tenantId` and `principalId`; `feed` on the Postgres engine; `capabilities`, whose `embeddingsConfigured` says whether dense retrieval is on; and `close`.

Other root exports: `MemoryError` and `RerankConfigError`, the `SEARCH_LIMIT_*` and `LIST_LIMIT_*` bounds, `MEMORY_GRANT_REQUIREMENTS` and `capabilityIdsForSurface`, `MEMORY_TOOL_DEFINITIONS`, `createMemoryHttpClient` for calling the routes over HTTP, and the `DocumentStore` port types. `loadMemoryConfig` is also at `@corbits/memory/config`.

### `createMemoryRoutes(deps)`

Returns a `Hono<TenantEnv>` sub-app. Mount it at `/api/tenants/:tenantId/memory`, below the middleware that sets `principal` and `tenant` on the context (Interchange's `createResolveTenant` does). Identity always comes from the context, never from the request body.

| Route                                       | Grant           | Does                                                             |
| ------------------------------------------- | --------------- | ---------------------------------------------------------------- |
| `POST /add`                                 | `memory:add`    | Adds a document, or a new version of one.                        |
| `POST /search`                              | `memory:search` | Hybrid search over the documents the caller can see.             |
| `GET /list`                                 | `memory:search` | Recent documents the caller can see.                             |
| `GET /feed`                                 | `memory:search` | New versions after a `feed_seq` cursor, for consumers.           |
| `POST /documents/:documentId/forget`        | `memory:forget` | Drops a document from search and redacts its text. Creator only. |
| `POST /documents/:documentId/purge`         | `memory:purge`  | Deletes a document and its versions. Creator only.               |
| `POST /versions/:versionId/retention-class` | `memory:forget` | Sets a version's retention class. Creator only.                  |

A missing principal answers `401` and a missing grant answers `403`. `callerResolver` is optional: it resolves a non-session caller to a `{ tenantId, principalId }` before the same grant checks run, and a malformed result answers `500`.

### `runMemoryMigrations(config, { schema, ftsLanguage })`

Takes the same `DBConfig` and `schema` as Interchange's `runMigrations`. `schema` holds the host's `tenant` and `principal` tables; this package's tables always go in `memory`. `ftsLanguage` is fixed into the full-text index and must match `FTS_LANGUAGE` at runtime.

Each run replays every file under a 5 s `lock_timeout`. Run it once per deploy before serving traffic; if it fails on the lock timeout behind a long query, run it again.

### `loadMemoryConfig()`

Reads the environment. `DATABASE_URL` must point at the same database as the `DBConfig` passed to `runMemoryMigrations`. Set `EMBED_BASE_URL` and `EMBED_MODEL` together for dense retrieval, or leave both unset for full-text search only.

| Variable               | Default                | Meaning                                             |
| ---------------------- | ---------------------- | --------------------------------------------------- |
| `DATABASE_URL`         | required               | Postgres with pgvector.                             |
| `DB_POOL_MAX`          | `8`                    | Connection pool size.                               |
| `FTS_LANGUAGE`         | `english`              | Postgres text search configuration.                 |
| `EMBED_BASE_URL`       | none                   | Embedding endpoint.                                 |
| `EMBED_MODEL`          | none                   | Embedding model name.                               |
| `EMBED_API_STYLE`      | `openai`               | `openai`, `tei` or `ollama`.                        |
| `EMBED_API_KEY`        | none                   | Bearer token for the embedding endpoint.            |
| `EMBED_TIMEOUT_MS`     | `10000`                | Embedding request timeout.                          |
| `RERANK_BASE_URL`      | none                   | Cross-encoder rerank endpoint.                      |
| `RERANK_MODEL`         | none                   | Rerank model name.                                  |
| `RERANK_API_KEY`       | none                   | Bearer token for the rerank endpoint.               |
| `RERANK_MAX_DOC_CHARS` | derived from the model | Per-document character budget sent to the reranker. |
| `RERANK_TIMEOUT_MS`    | `10000`                | Rerank request timeout.                             |

### `mountWorkflowMemory(app, { memory, agentToken })`

Registers `/add`, `/search`, `/list` and `/feed` for deployed agents. A request carries the agent's bearer token and an `x-workflow-run-address` header; `agentToken.verify` checks the token and `agentToken.resolveRun` maps the address to the run's tenant and principal. Every call is confined to that run.

### `@corbits/memory/sidecar-bundle`

`memory` is an `@intx/agent` tool pack: `memory_add`, `memory_search`, `memory_list` and `memory_feed`. They call the run-scoped routes at `/api/workflow-memory` through the agent's `hub` credential.

### `@corbits/memory/distiller`

`createResidentDistiller({ mailTo, inference })` returns a workflow and an agent that turn new versions from the feed into distilled claims. Each mail to `mailTo` runs one pass; the host decides when to send it.

## Using with Interchange

Run the migrations after Interchange's, mount the tenant and run-scoped routes on the same `Memory`, grant `memory:add` and `memory:search` to principals that use it (and `memory:forget` and `memory:purge` to creators who may retract their documents), and give agents the tool pack.

```ts
import { timeWindowEvaluator } from "@intx/authz";
import { createDB, createGrantStore, runMigrations } from "@intx/db";
import { createRequireGrant } from "@intx/hub-api";
import {
  createMemory,
  createMemoryRoutes,
  loadMemoryConfig,
} from "@corbits/memory";
import { runMemoryMigrations } from "@corbits/memory/migrations";

const dbConfig = {
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "interchange",
};

await runMigrations(dbConfig, { schema: "public" });
await runMemoryMigrations(dbConfig, {
  schema: "public",
  ftsLanguage: "english",
});

const { db } = createDB(dbConfig);
const grantStore = createGrantStore(db);
const conditionRegistry = { time_window: timeWindowEvaluator };
const memory = createMemory({
  config: loadMemoryConfig(),
  grantStore,
  conditionRegistry,
});

export const memoryRoutes = createMemoryRoutes({
  memory,
  requireGrant: createRequireGrant({ grantStore, conditionRegistry }),
});
```

Mount `memoryRoutes` on the hub app at `/api/tenants/:tenantId/memory`, behind the hub's auth and tenant middleware.

For agents, mount `mountWorkflowMemory(new Hono<WorkflowMemoryEnv>(), { memory, agentToken })` at `/api/workflow-memory`. `agentToken` is the host's `{ verify, resolveRun }`: `verify` checks the agent's bearer (for example with `createAgentTokenVerifier` from [`@corbits/agent-token`](https://github.com/corbitsdev/corbits-agent-token)), and `resolveRun` maps a run address to the run's tenant and principal from the hub's workflow runs.

Add the tools to an agent and bind its `hub` credential to the agent's hub token when you deploy it:

```ts
import { defineAgent, type InferencePreference } from "@intx/agent";
import { memory } from "@corbits/memory/sidecar-bundle";

export function buildAssistant(sources: readonly InferencePreference[]) {
  return defineAgent({
    id: "assistant",
    systemPrompt: "You save and recall the team's notes.",
    capabilities: [],
    inference: { sources },
    tools: [memory],
  });
}
```

## Upgrading from 0.1

- `createMemory({ app })` and `registerMemoryRoutes` are replaced by `createMemoryRoutes(deps)`. Mount it with `app.route("/api/tenants/:tenantId/memory", …)`.
- `runMemoryMigrations(databaseUrl, opts)` is now `runMemoryMigrations(dbConfig, { schema, ftsLanguage })`. `ftsLanguage` is required.
- The first run upgrades a 0.1.0 database in place with no data loss and drops the 0.1.0 migration ledger. You cannot roll back to 0.1.0, and 0.1.0 and 0.2.0 replicas must not share a database.
- `@intx/*`, `drizzle-orm`, `hono`, `hono-openapi` and `postgres` are peer dependencies.
- Internal helpers and test fakes are no longer exported from the package root.

See the [changelog](https://github.com/corbitsdev/corbits-memory/blob/main/CHANGELOG.md) for the full list.

## License

[LGPL-2.1-only](https://github.com/corbitsdev/corbits-memory/blob/main/LICENSE)
