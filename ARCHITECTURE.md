# Corbits Memory — Architecture

A memory **add / search / list** SDK that mounts onto an Interchange hub. The
host owns auth, tenancy, and the process; this library owns the durable memory
plane and the protected routes that read and write it.

## Why an SDK, not a service

The store was detachable from a larger backend, then mountable:

- No memory table has a foreign key into any control-plane table — cross-refs
  (`tenant_id`, `principal_id`, source refs) are plain `text`. Tables live in
  the **`memory`** schema (same Postgres URL as the host is fine).
- Embedding and reranking go out as plain HTTP to configured model endpoints.
- Document access is Interchange grant tags on the row (`accessTags` + creator),
  not a private ACL engine inside this package.

It ships as `createMemory(…)` plus `createMemoryRoutes(deps)`: the host builds
the plane, mounts the returned Hono sub-app, and passes its `requireGrant`; the
routes read identity from request context and talk to the DocumentStore. No
second server.

## Product path

```
add  →  ingest elements (store/chunk/embed)  →  process (optional, host)
```

```
tools / host ingest workflow  →  /api/tenants/:tenantId/memory/*  →  Memory plane  →  DocumentStore
         ↑
   Interchange auth + principal + grants

sidecar-bundle (deployed agent)  →  /api/workflow-memory/*  →  Memory plane  →  DocumentStore
         ↑
   hub credential + x-workflow-run-address  (mountWorkflowMemory, no session)
```

Mount is intentionally small. The host already has `app`, grants, and
principal middleware; memory only needs to be handed those and the vector
config (or an injected store).

**Ingest elements** run on the default store inside `add` (raw capture, chunks,
edges, embed). **Process** (claims, LLM link/classify) is host-owned inference,
preferably in the same workflow body as the add. Capture **feed** + distiller
helpers are optional multi-writer / backfill — not the primary path.

## Boundaries

- **Runtime**: Bun + Hono, mounted on the host app. **DB**: own pgvector
  Postgres (`DATABASE_URL`) unless `documentStore` is injected.
  **Types**: arktype at every route boundary.
- **No auth of its own.** By default, Interchange resolves the caller and
  puts `principal` + `tenant` on context; routes read identity from there
  (`tenantId = principal.tenantId`, `principalId = principal.id`). A host
  with a non-browser caller (e.g. a workflow-run child with its own sidecar
  bearer token) may instead pass `callerResolver` to `createMemoryRoutes`
  — the host still does 100% of the authenticating, it just
  hands the resolved `{ tenantId, principalId }` in through the seam instead
  of setting context itself. Either way the resolved identity, never
  anything from the request body, is what `grantGuard` authorizes.
- **Grants delegate to the host.** Pass `grantStore` + `conditionRegistry`;
  routes use `createRequireGrant("memory", action)`.
- **Two authorization mechanisms, not one — know which is source of truth
  for what.** (1) Grant tags decide *capability* (may this principal call
  `add`/`search`/`forget`/`purge` at all — `requireGrant`) and *visibility*
  (which documents a principal may see — `accessTags` + `canAccessDocument`
  in `grant-tags.ts`, where a share grant legitimately widens who can find a
  document). (2) A separate, imperative **ownership** check — the creator
  lookup in `services/retention-ownership.ts`, called from `memory.ts` —
  decides who may *forget or purge* a specific document, and is the sole
  source of truth for "whose document is this": it is never derived from
  grant tags and a share grant never satisfies it. `MemoryGrantRequirement.
  installHint` (`grant-requirements.ts`) looks adjacent to this but is not:
  it is advisory metadata for install tooling sizing a capability grant,
  read by nothing at request time. Do not extend mechanism (1) expecting it
  to cover ownership — extend `retention-ownership.ts` instead.
- **Dependencies**: `@intx/hub-api`, `@intx/authz`, `@intx/log`, Hono, Drizzle,
  arktype, `postgres`, `hono-openapi`. LGPL-2.1 — see `LICENSE`.

## Identity — context in, data out

1. **Who is calling** is the request principal. Clients never send
   `tenant_id` / `principal_id` on the body.
2. **What is stored** is opaque data: `tenant_id`, `principal_id`,
   `created_by_kind`, `access_tags`, source refs. Queries scope by `tenant_id`
   first; document access is grant tags + creator.

## Layers (default pgvector store)

- `raw_capture` — immutable original content (replay substrate).
- `derived` — chunks / embeddings / authority / edges from raw.
- `transform_config` + replay — rebuild derived from raw without re-fetch.

Injected DocumentStores own their own persistence model; the plane still
exposes the same three verbs.

## Mounted surface

`createMemoryRoutes(deps)`, mounted at `/api/tenants/:tenantId/memory`, serves:

- `POST /api/tenants/:tenantId/memory/add` — ingest (raw + derive on the default store).
- `POST /api/tenants/:tenantId/memory/search` — hybrid retrieval (FTS + dense → RRF → rerank →
  authority/recency → MMR); optional live `SourceProvider` merge (fail-soft).
- `GET /api/tenants/:tenantId/memory/list` — recent documents, same grant-tag filter as local
  search.
- `POST /api/tenants/:tenantId/memory/documents/:documentId/forget` — tombstone
  (grant `memory:forget`; creator-only, see below).
- `POST /api/tenants/:tenantId/memory/documents/:documentId/purge` — hard
  delete (grant `memory:purge`; creator-only; irreversible).
- `POST /api/tenants/:tenantId/memory/versions/:versionId/retention-class` —
  set retention class (grant `memory:forget`; creator-only).

Forget and purge are deliberately separate routes and separate grant actions
(never one route with a boolean flag) — a host wiring a "forget this" button
cannot accidentally wire up permanent deletion. `sweepEphemeral` (TTL
auto-deprecation) is **not** HTTP-routed: it is a maintenance sweep a host
schedules on its own cron, not a user action; call it in-process against the
returned `Memory`. See docs/RETENTION.md.

Returns an in-process `Memory` (`add`, `search`, `list`, `close`, plus the
optional retention writes) for host workers and ingestion modules that
already resolved identity.

**Capture** is the write path inside `add` (raw capture → chunks / edges /
embed on the default store). **Search** is hybrid retrieval on the same
plane, whether the caller arrived via tenant routes or the sidecar mount.

## Sidecar mount (`mountWorkflowMemory`)

Deployed agents do not install this package as a git sidecar. They carry
the factory at `@corbits/memory/sidecar-bundle`, which holds no client
code, no base URL, and no token: it resolves the host `hub` credential and
calls the run-scoped routes under `/api/workflow-memory/*`. That mount is
**parallel** to the tenant routes — two auth conventions stay on two
mounts so neither is harder to reason about.

```ts
import { mountWorkflowMemory } from "@corbits/memory";

mountWorkflowMemory(workflowMemoryApp, {
  memory,
  agentToken: { verify, resolveRun },
});
app.route("/api/workflow-memory", workflowMemoryApp);
```

Authorization on this mount **is the token itself**: the hub only mints an
agent token for a definition it already authorized, and every call is
confined to the verified run's tenant and principal. The mount runs **no
grant check of its own** and has no tenant override. A bearer minted for
one workbench cannot act on another's run (`verify` tenant must match
`resolveRun` tenant). Unrecognized bearer, unknown run address, and
cross-tenant mismatch all return the same **401**.

The sidecar factory (`src/sidecar-bundle.ts`) maps `memory_add` /
`memory_search` / `memory_list` / `memory_feed` onto those run-scoped
routes. Relative paths only — a mediated HTTP handle resolves them against
the origin it is pinned to. Capture and search still execute on the same
in-process `Memory` plane as the tenant routes.

## Provenance

Framework-agnostic core (chunking, embed/rerank clients, hybrid search, MMR)
was extracted from an internal RAG implementation. Persistence and the
mountable surface are native to this repo.
