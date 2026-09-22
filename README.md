# @corbits/memory

Memory for [Interchange](https://github.com/corbitsdev) hubs: **add**, **search**, **list**.

Mount it on the hub and routes land under `/api/tenants/:tenantId/memory/*`, where the hub's existing `createResolveTenant` middleware supplies principal plus tenant — the same pattern as workflows, assets, and agents. Deployed agents use the sidecar bundle against the run-scoped routes under `/api/workflow-memory/*`; ingestion modules use the tenant routes or the in-process plane.

## Install

```bash
bun add @corbits/memory
```

Runs on Bun 1.2+. TypeScript source ships as the package entry (see `package.json` `exports`); Node >= 24 covers Node-side tooling such as typecheck and pack.

Pair with the peer stack already present on an Interchange hub: `@intx/authz`, `@intx/hub-api`, `hono`. Agent tools also use `@intx/agent` (a direct dependency).

## Quickstart

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

Bodies stay lean: tenant and principal come from `c.get("principal")` in context (set by the hub's tenant middleware). Requests without a principal receive a 401; requests without the grant receive a 403.

```http
POST /api/tenants/:tenantId/memory/add      { "title", "text", "access_tags"?, "share"? }
POST /api/tenants/:tenantId/memory/search   { "query", "limit"?, "kinds"?, "entity_ids"?, "sources"?, "includeEvidence"? }
GET  /api/tenants/:tenantId/memory/list     ?limit=
GET  /api/tenants/:tenantId/memory/feed     ?after=&limit=&exclude_generator=
POST /api/tenants/:tenantId/memory/documents/:documentId/forget            { "reason"? }
POST /api/tenants/:tenantId/memory/documents/:documentId/purge             (empty body)
POST /api/tenants/:tenantId/memory/versions/:versionId/retention-class     { "retention_class": "durable" | "standard" | "ephemeral" | "source_only" }
```

## Feed

`GET …/memory/feed` pulls new live versions after a cursor (`after` = last consumed `feedSeq`, `limit` 1–100, `exclude_generator` skips one `generator_agent_id`). It uses the `("memory", "search")` grant with the same grant-tag post-filter as search. Details: [`docs/FEED.md`](docs/FEED.md). The resident distiller consumes this feed — see `@corbits/memory/distiller` (`createResidentDistiller`, `runDistillTick`) and [`docs/DISTILLER.md`](docs/DISTILLER.md).

## Retention

- `POST …/documents/:documentId/forget` — tombstone: the document leaves search and feed, chunk text is redacted, and version rows remain for audit. Uses grant `("memory", "forget")` plus a creator check. Plane verb: `memory.tombstoneDocument`.
- `POST …/documents/:documentId/purge` — hard delete. Applies once durable versions are tombstoned. Uses grant `("memory", "purge")` plus a creator check. Plane verb: `memory.hardDeleteDocument`.
- `POST …/versions/:versionId/retention-class` — sets a version's retention class (`setRetentionClass`). Uses grant `("memory", "forget")` plus a check that the caller created the version.

Details: [`docs/RETENTION.md`](docs/RETENTION.md). Engine config for these paths comes from `@corbits/memory/config` (`loadMemoryConfig`, `MemoryConfig`).

## Agent tools

A deployed agent carries the memory tools through one factory at `@corbits/memory/sidecar-bundle`. The bundle holds client code free of base URLs and tokens: it resolves the `hub` credential handle from the host-assembled runtime capabilities and calls the run-scoped routes through that mediated fetch, naming its run with the `x-workflow-run-address` header.

| Tool | Route |
| --- | --- |
| `memory_add` | `POST /api/workflow-memory/add` |
| `memory_search` | `POST /api/workflow-memory/search` |
| `memory_list` | `GET /api/workflow-memory/list` |
| `memory_feed` | `GET /api/workflow-memory/feed` |

Those routes are a second, parallel mount — the tenant routes above keep their session auth:

```ts
import { mountWorkflowMemory } from "@corbits/memory";

mountWorkflowMemory(workflowMemoryApi, {
  memory,
  agentToken: { verify, resolveRun }, // host token + run lookup
});
app.route("/api/workflow-memory", workflowMemoryApi);
```

`verify` returns `{ tenantId, definitionId }` for a recognized bearer, and `resolveRun` maps the run address to `{ tenantId, principalId, runId }`. A token from another tenant receives the same 401 as an unknown bearer. Every call stays scoped to that run's tenant and principal; the body carries content only.

Host checklist:

1. Mount the tenant routes: `createMemory({ app, grantStore, … })`.
2. Mount `mountWorkflowMemory` and bind the agent's hub credential to the `hub` handle on its definition.
3. For peer and space share visibility, grant `search` on the relevant document tags (see `docs/AUTHZ-DOCUMENT-ACCESS.md`).

## Ingestion

Host workers with resolved identity call the plane directly, without HTTP:

```ts
await memory.add({
  tenantId,
  principalId,
  content: { title, text },
});
const { items } = await memory.search({ tenantId, principalId, query });
```

Inference stays host-owned: run a model, then `add` / `search`. Core focuses on the memory workflow.

## Document access

Capability grants (`memory:add` / `memory:search`) gate the routes. Per-document visibility uses Interchange grant tags on the row (`access_tags`); the creator always sees their own docs. Details: [`docs/AUTHZ-DOCUMENT-ACCESS.md`](docs/AUTHZ-DOCUMENT-ACCESS.md).

## Config

`loadMemoryConfig()` (from `@corbits/memory/config`) reads env (see `.env.example`). For the default pgvector store, set `DATABASE_URL`, `EMBED_BASE_URL`, and `EMBED_MODEL`.

```ts
import { runMemoryMigrations } from "@corbits/memory/migrations";
await runMemoryMigrations(process.env.DATABASE_URL!);
```

Pass `documentStore` to use fakes, a host store, or a sibling adapter alongside Postgres. `createFakeDocumentStore` (from `@corbits/memory`) covers tests and local development.

## Interchange

This package is built for Interchange hubs: tenant-scoped routes, grant-gated tools, and the sidecar bundle follow hub conventions for auth, tenancy, and agent deployment. The in-process plane (`memory.add` / `memory.search`) gives ingestion workers the same semantics without HTTP.

## More

- Product: [`PRODUCT.md`](PRODUCT.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Internals: [`IMPLEMENTATION.md`](IMPLEMENTATION.md)

## License

LGPL-2.1-only — see [`LICENSE`](LICENSE).
