# @corbits/memory

Memory for [Interchange](https://github.com/corbitsdev) hubs: **add**, **search**,
**list**.

Mount it on the hub. Routes land under `/api/tenants/:tenantId/memory/*`, so
the hub’s existing `createResolveTenant` middleware supplies principal + tenant
— same as workflows, assets, and agents. Deployed agents carry the sidecar
bundle and call the run-scoped routes under `/api/workflow-memory/*`;
ingestion modules call the tenant routes or the in-process plane. That’s the
product.

Requires Bun 1.2+. `engines.node` is `>=24` as a floor for Node-side tooling
(typecheck, pack); native Node does not load this package's extensionless
TypeScript source.

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

Bodies never carry tenant/principal — routes read `c.get("principal")` from
context (set by the hub’s tenant middleware). Missing principal → **401**.
Missing grant → **403**.

```http
POST /api/tenants/:tenantId/memory/add      { "title", "text", "access_tags"?, "share"? }
POST /api/tenants/:tenantId/memory/search   { "query", "limit"?, "kinds"?, "entity_ids"?, "sources"?, "includeEvidence"? }
GET  /api/tenants/:tenantId/memory/list     ?limit=
```

## Agent tools (sidecar bundle)

A deployed agent carries the memory tools through one factory at
`@corbits/memory/sidecar-bundle`. It holds no client code, no base URL and no
token: it resolves the `hub` credential handle from the host-assembled runtime
capabilities and calls the run-scoped routes through that mediated fetch,
naming its run with the `x-workflow-run-address` header.

| Tool | Route |
| --- | --- |
| `memory_add` | `POST /api/workflow-memory/add` |
| `memory_search` | `POST /api/workflow-memory/search` |
| `memory_list` | `GET /api/workflow-memory/list` |
| `memory_feed` | `GET /api/workflow-memory/feed` |

Those routes are a **second, parallel mount** — the tenant routes above keep
their session auth untouched:

```ts
import { mountWorkflowMemory } from "@corbits/memory";

mountWorkflowMemory(workflowMemoryApi, {
  memory,
  agentToken: { verify, resolveRun }, // host's own token + run lookup
});
app.route("/api/workflow-memory", workflowMemoryApi);
```

`verify` returns `{ tenantId, definitionId }` for a recognized bearer (or
`undefined`), `resolveRun` maps the run address to `{ tenantId, principalId,
runId }`. A token whose tenant is not the run's tenant is refused with the same
401 as an unknown bearer. Every call is scoped to that run's tenant and
principal; the body never carries identity.

**Host checklist**

1. Mount the tenant routes: `createMemory({ app, grantStore, … })`.
2. Mount `mountWorkflowMemory` and bind the agent's hub credential to the
   `hub` handle on its definition.
3. For peer/space share visibility, grant `search` on the relevant document
   tags (see `docs/AUTHZ-DOCUMENT-ACCESS.md`).

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
