# @corbits/memory

Memory for [Interchange](https://github.com/corbitsdev) hubs: **add**, **search**,
**list**.

Mount it on the hub. Routes land under `/api/tenants/:tenantId/memory/*`, so
the hub’s existing `createResolveTenant` middleware supplies principal + tenant
— same as workflows, assets, and agents. Workflow agents install the package’s
`defineTool` factories; ingestion modules call the same routes or the in-process
plane. That’s the product.

Requires Bun 1.2+.

## Install

Not published to npm yet:

```bash
bun add git+https://github.com/corbitsdev/corbits-memory.git
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
  config: loadMemoryConfig(), // KNOWLEDGE_DATABASE_URL + embed env
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

Bodies never carry tenant/principal — routes read `c.get("principal")` from
context (set by the hub’s tenant middleware). Missing principal → **401**.
Missing grant → **403**.

```http
POST /api/tenants/:tenantId/memory/add      { "title", "text", "access_tags"?, "share"? }
POST /api/tenants/:tenantId/memory/search   { "query", "limit"? }
GET  /api/tenants/:tenantId/memory/list     ?limit=
```

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
| `memoryBaseUrl` | Hub origin, e.g. `https://hub.example` |
| `memoryTenantId` | Tenant path segment |
| `memoryAuthToken` | Bearer token accepted by the hub for that principal |

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

`loadMemoryConfig()` reads env (see `.env.example`). For the default pgvector
store you need `KNOWLEDGE_DATABASE_URL`, `EMBED_BASE_URL`, `EMBED_MODEL`.

```ts
import { runMemoryMigrations } from "@corbits/memory/migrations";
await runMemoryMigrations(process.env.KNOWLEDGE_DATABASE_URL!);
```

Inject `documentStore` to use fakes, a host store, or a sibling adapter instead
of Postgres.

## More

- Product: [`PRODUCT.md`](PRODUCT.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Internals: [`IMPLEMENTATION.md`](IMPLEMENTATION.md)

## License

LGPL-2.1 — see [`LICENSE`](LICENSE).
