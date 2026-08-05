# Corbits Memory — Architecture

A memory **add / search / list** SDK that mounts onto an Interchange hub. The
host owns auth, tenancy, and the process; this library owns the durable memory
plane and the protected routes that read and write it.

## Why an SDK, not a service

The store was detachable from a larger backend, then mountable:

- No memory table has a foreign key into any control-plane table — cross-refs
  (`tenant_id`, `principal_id`, source refs) are plain `text`.
- Embedding and reranking go out as plain HTTP to configured model endpoints.
- Document access is Interchange grant tags on the row (`accessTags` + creator),
  not a private ACL engine inside this package.

It ships as `createMemory({ app, … })`: the host passes its Hono app and grant
store; the library registers routes, reads identity from request context, and
talks to its DocumentStore. No second server.

## Product path

```
tools / ingestion  →  /api/tenants/:tenantId/memory/*  →  Memory plane  →  DocumentStore
         ↑
   Interchange auth + principal + grants
```

Mount is intentionally small. The host already has `app`, grants, and
principal middleware; memory only needs to be handed those and the vector
config (or an injected store).

## Boundaries

- **Runtime**: Bun + Hono, mounted on the host app. **DB**: own pgvector
  Postgres (`KNOWLEDGE_DATABASE_URL`) unless `documentStore` is injected.
  **Types**: arktype at every route boundary.
- **No auth of its own.** Interchange resolves the caller and puts `principal`
  + `tenant` on context; routes read identity from there
  (`tenantId = principal.tenantId`, `principalId = principal.id`).
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

Returns an in-process `Memory` (`add`, `search`, `list`, `close`) for host
workers and ingestion modules that already resolved identity.

**Agent tools are not in this package.** Routes are OpenAPI-described
(`describeRoute`). The host mounts `@corbitsdev/hono-openapi-mcp` (or any
OpenAPI→tools bridge) so agents call these routes under Interchange auth.

## Provenance

Framework-agnostic core (chunking, embed/rerank clients, hybrid search, MMR)
was extracted from an internal RAG implementation. Persistence and the
mountable surface are native to this repo.
