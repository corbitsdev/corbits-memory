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

It ships as `createMemory({ app, … })`: the host passes its Hono app and grant
store; the library registers routes, reads identity from request context, and
talks to its DocumentStore. No second server.

## Product path

```
add  →  ingest elements (store/chunk/embed)  →  process (optional, host)
```

```
tools / host ingest workflow  →  /api/tenants/:tenantId/memory/*  →  Memory plane  →  DocumentStore
         ↑
   Interchange auth + principal + grants
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
  bearer token) may instead pass `callerResolver` (`RouteDeps` /
  `createMemory`) — the host still does 100% of the authenticating, it just
  hands the resolved `{ tenantId, principalId }` in through the seam instead
  of setting context itself. Either way the resolved identity, never
  anything from the request body, is what `grantGuard` authorizes.
- **Grants delegate to the host.** Pass `grantStore` + `conditionRegistry`;
  routes use `createRequireGrant("memory", action)`.
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

`createMemory({ app })` registers:

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

**Agent tools live in this package** as thin HTTP clients
(`@corbits/memory/tools` / `interchange.tools`): `defineTool` factories that
`fetch` the mounted routes with install credentials. They do not import the
in-process plane. OpenAPI→MCP remains an optional host bridge.

## Provenance

Framework-agnostic core (chunking, embed/rerank clients, hybrid search, MMR)
was extracted from an internal RAG implementation. Persistence and the
mountable surface are native to this repo.
