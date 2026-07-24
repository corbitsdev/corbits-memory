# Knowledge Engine — Architecture

A knowledge capture + retrieval SDK that mounts onto an Interchange hub. The
host owns auth, tenancy, and the process; this library owns the knowledge /
vector plane and the routes that read and write it.

## Why an SDK, not a service

The knowledge store was originally built inside a larger backend. It turned out
to be cleanly detachable, and then cleanly *mountable*:

- No knowledge table has a foreign key into any control-plane table — every
  cross-reference (`tenant_id`, `principal_id`, source refs) is plain `text`.
- Embedding and reranking go out as plain HTTP to configured model endpoints,
  not through any agent runtime.
- The ACL rule is a self-contained scope stored on the row, not a join against
  a grant engine.

So the engine needs nothing but a pgvector Postgres and an embed/rerank
endpoint. It ships as `mountKnowledgeEngine(app, opts)`: the host passes its
Hono app and its grant store; the engine mounts its routes, reads identity from
the request context, and talks to its own vector store. No second server, no
HTTP hop.

## Boundaries

- **Runtime**: Bun + Hono, mounted on the host's app. **DB**: its own pgvector
  Postgres (`KNOWLEDGE_DATABASE_URL`). **Types**: arktype at every route
  boundary.
- **No auth of its own.** The SDK authenticates nothing. Interchange resolves
  the caller (session, `cke_` API key, or MCP OAuth) and puts `principal` +
  `tenant` on the request context; each mounted route reads identity from there
  (`caller(c)` → `scopeId = principal.tenantId`, `subjectId = principal.id`).
- **Grants delegate to the host.** Pass `grants` (`{ grantStore,
  conditionRegistry }`) and the SDK guards routes with Interchange's
  `createRequireGrant`.
- **Dependencies** are public npm only — `@intx/hub-api` (`TenantEnv`,
  `createRequireGrant`), `@intx/authz` (`authorize`), `@intx/log`, Hono,
  Drizzle, arktype, `postgres`, `hono-openapi`. Eight total. LGPL-2.1-licensed —
  see `LICENSE`.

## Identity — read from context, stored as data

1. **Who is calling** is the request principal, read off the Interchange
   context. Clients never send `tenant_id`/`principal_id` — the handlers read
   only content fields (title/text/query/k/acl) and take identity from context.
2. **What is stored** is opaque data on every record: `tenant_id`,
   `principal_id`, `created_by_kind` (human/agent/system), `source_class`, and
   relations (the edge graph). Every query is scoped by `tenant_id` first, then
   the document ACL is matched against the caller's subject.

Cross-tenant isolation is enforced at query time by `tenant_id`; document-level
visibility (allow/block) is enforced on top. This is the trust
model.

## Layers

- `raw_capture` — immutable, append-only original content. The replay substrate.
- `derived` — chunks / embeddings / authority / edges, all derived from
  `raw_capture`.
- `transform_config` + replay — a named, versioned transform (chunk strategy,
  embed model, rerank endpoint, authority weights, MMR λ) that rebuilds the
  derived layer from raw without re-fetching source.

## Mounted surface

`mountKnowledgeEngine` adds, under the host app:

- `POST /api/knowledge/capture` — ingest content (raw + derive).
- `POST /api/knowledge/search` — hybrid retrieval: FTS + dense (pgvector) → RRF
  fusion → cross-encoder rerank → bounded authority/recency boosts → MMR.
- `GET /api/knowledge/timeline` — recent captures for the caller's scope.

MCP is not part of this package — mount `@corbitsdev/hono-openapi-mcp` to expose
these routes as MCP tools.

External ingestion (Linear, GitHub, …) is not a route here — the host
authenticates the forwarder to Interchange and it calls the capture route, or
the host calls `knowledge.capture()` directly.

## Provenance

The framework-agnostic core (chunk strategies, embed client + model registry,
authority weighting, hybrid search, MMR, rerank client, ingestion adapters) was
extracted from an internal RAG implementation and generalized. The persistence
and the mountable surface are native to this repo.
