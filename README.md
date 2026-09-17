# @corbits/memory

Memory for [Interchange](https://github.com/corbitsdev) hubs: **add**, **search**,
**list**.

Mount it on the hub. Routes land under `/api/tenants/:tenantId/memory/*`, so
the hub’s existing `createResolveTenant` middleware supplies principal + tenant
— same as workflows, assets, and agents. Workflow agents install the package’s
`defineTool` factories; ingestion modules call the same routes or the in-process
plane. That’s the product.

## Requirements

**Bun-only runtime.** This package ships TypeScript source (`src/*.ts`, see
`package.json` `exports`) and declares `"engines": { "bun": ">=1.2.0" }` — run
it under Bun 1.2+. There is intentionally no `dist` build step.

## Install

```bash
npm install @corbits/memory
```

Peer stack you already have on an Interchange hub: `@intx/authz`, `@intx/hub-api`,
`hono`. Agent tools also need `@intx/agent` (declared as a direct dependency).

## Mount (≈5 lines)

On a real hub you already have `app` (with session +
`app.use("/api/tenants/:tenantId/*", resolveTenant)`), `grantStore`, and
`conditionRegistry`:

```ts
import { createMemory, loadMemoryConfig } from "@corbits/memory";

const memory = createMemory({
  app,
  config: loadMemoryConfig(), // DATABASE_URL + embed env
  grantStore,
  conditionRegistry,
});
```

That exposes:

| Method | Path | Grant |
| --- | --- | --- |
| POST | `/api/tenants/:tenantId/memory/add` | `("memory", "add")` |
| POST | `/api/tenants/:tenantId/memory/search` | `("memory", "search")` |
| GET | `/api/tenants/:tenantId/memory/list` | `("memory", "search")` |
| GET | `/api/tenants/:tenantId/memory/feed` | `("memory", "search")` |
| POST | `/api/tenants/:tenantId/memory/documents/:documentId/forget` | `("memory", "forget")` |
| POST | `/api/tenants/:tenantId/memory/documents/:documentId/purge` | `("memory", "purge")` |
| POST | `/api/tenants/:tenantId/memory/versions/:versionId/retention-class` | `("memory", "forget")` |

Bodies never carry tenant/principal — routes read `c.get("principal")` from
context (set by the hub’s tenant middleware). Missing principal → **401**.
Missing grant → **403**.

```http
POST /api/tenants/:tenantId/memory/add      { "title", "text", "access_tags"?, "share"? }
POST /api/tenants/:tenantId/memory/search   { "query", "limit"?, "kinds"?, "entity_ids"?, "sources"?, "includeEvidence"? }
GET  /api/tenants/:tenantId/memory/list     ?limit=
GET  /api/tenants/:tenantId/memory/feed     ?after=&limit=&exclude_generator=
POST /api/tenants/:tenantId/memory/documents/:documentId/forget            { "reason"? }
POST /api/tenants/:tenantId/memory/documents/:documentId/purge             (no body)
POST /api/tenants/:tenantId/memory/versions/:versionId/retention-class     { "retention_class": "durable" | "standard" | "ephemeral" | "source_only" }
```

### Feed

`GET …/memory/feed` pulls new live versions after a cursor (`after` = last
consumed `feedSeq`, `limit` 1–100, `exclude_generator` skips one
`generator_agent_id`). Grant: `("memory", "search")`, same grant-tag
post-filter as search. Details: [`docs/FEED.md`](docs/FEED.md); the resident
distiller consumes this feed — see `@corbits/memory/distiller`
(`createResidentDistiller`, `runDistillTick`) and
[`docs/DISTILLER.md`](docs/DISTILLER.md).

### Retention (`forget`, `purge`, `retention-class`)

- `POST …/documents/:documentId/forget` — tombstone: stops appearing in
  search/feed, chunk text redacted, version rows stay for audit.
  Grant `("memory", "forget")` **plus** the caller must be the document’s
  creator. Plane verb: `memory.tombstoneDocument`.
- `POST …/documents/:documentId/purge` — hard delete, irreversible; refused
  while a durable version is untombstoned. Grant `("memory", "purge")`
  **plus** creator check. Plane verb: `memory.hardDeleteDocument`.
- `POST …/versions/:versionId/retention-class` — set a version’s retention
  class (`setRetentionClass`). Grant `("memory", "forget")` **plus** the
  caller must be that version’s creator.

Details: [`docs/RETENTION.md`](docs/RETENTION.md). Engine config for these
paths comes from `@corbits/memory/config` (`loadMemoryConfig`,
`MemoryConfig`).

## Workflow agent tools

This package exports Interchange `defineTool` factories at
`@corbits/memory/tools` (also `package.json` → `interchange.tools`). Each tool
is a thin HTTP client: install credentials in agent env, call the mounted hub
routes. No plane inject, no model-supplied identity.

| Factory id | Tool name | HTTP |
| --- | --- | --- |
| `@corbits/memory/add` | `memory_add` | `POST …/memory/add` |
| `@corbits/memory/search` | `memory_search` | `POST …/memory/search` |
| `@corbits/memory/list` | `memory_list` | `GET …/memory/list` |

**Env keys** (declared on each factory’s `requires`):

| Key | Meaning |
| --- | --- |
| `memoryBaseUrl` | Hub **origin** only, e.g. `https://hub.example` (no `/api/...` path) |
| `memoryTenantId` | Tenant path segment (must match the principal’s tenant on the hub) |
| `memoryAuthToken` | Bearer token the hub accepts for that agent principal |

**Host checklist**

1. Mount routes: `createMemory({ app, grantStore, … })` under the hub tenant tree.
2. Grant the agent principal `memory:add` and/or `memory:search` (`list` uses `search`).
3. For peer/space share visibility, also grant `search` on the relevant document tags (see `docs/AUTHZ-DOCUMENT-ACCESS.md`).
4. Install factories on the workflow and set the three env keys above.
5. Auth is **Bearer only** on the tool client — session cookies are not sent.
6. Tool results are **JSON strings** (`stringTool`); pass `AbortSignal` if you need hang protection (no default client timeout).

```ts
import { memoryAdd, memorySearch, memoryList } from "@corbits/memory/tools";

// On a workflow / agent definition — install like any open tool package:
// tools: [memoryAdd, memorySearch, memoryList]
// and supply memoryBaseUrl / memoryTenantId / memoryAuthToken in agent env.
```

OpenAPI→MCP remains available as an alternative host bridge; the shipped
`defineTool`s are the primary install path for workflow agents.

## Ingestion (in-process)

Host workers that already resolved identity can call the plane without HTTP:

```ts
await memory.add({
  tenantId,
  principalId,
  content: { title, text },
});
const { items } = await memory.search({ tenantId, principalId, query });
```

Inference is host-owned: run your model, then `add` / `search`. Core does not
ship an answer endpoint.

## Document access

Capability grants (`memory:add` / `memory:search`) gate the routes. Per-document
visibility is Interchange **grant tags** on the row (`access_tags`); the creator
always sees their own docs. Details:
[`docs/AUTHZ-DOCUMENT-ACCESS.md`](docs/AUTHZ-DOCUMENT-ACCESS.md).

## Config

`loadMemoryConfig()` (from `@corbits/memory/config`) reads env (see `.env.example`). For the default pgvector
store you need `DATABASE_URL`, `EMBED_BASE_URL`, `EMBED_MODEL`.

```ts
import { runMemoryMigrations } from "@corbits/memory/migrations";
await runMemoryMigrations(process.env.DATABASE_URL!);
```

Inject `documentStore` to use fakes, a host store, or a sibling adapter instead
of Postgres.

## More

- Product: [`PRODUCT.md`](PRODUCT.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Internals: [`IMPLEMENTATION.md`](IMPLEMENTATION.md)

## License

LGPL-2.1 — see [`LICENSE`](LICENSE).
