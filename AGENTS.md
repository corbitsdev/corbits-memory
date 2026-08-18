# Agent guide — @corbits/memory

A library, not a service. `src/` is the whole product: a memory **add / search /
list** SDK that **mounts onto a host Interchange app**. There is no server,
port, or process entrypoint here, and there never should be.


## Commands

```bash
bun install              # Bun 1.2+ required
bun run typecheck        # tsc --noEmit
bun run test             # bun test ./src (no network, no Postgres)
bun run db:setup         # apply migrations (needs DATABASE_URL)
docker compose up -d     # local pgvector + model endpoints for manual runs
```

CI runs `typecheck` + `test` — both must pass before any push.

## Layout

- `src/index.ts` — public surface: `createMemory` (optional `app` registers HTTP), `registerMemoryRoutes`

- `src/mount-config.ts` / `src/config.ts` — mount config + engine config
- `src/routes/` — Hono routes (`add`, `search`, `list`)
- `src/tools/` — Interchange `defineTool` factories (`@corbits/memory/tools`);
  HTTP clients for mounted routes (env credentials; no in-process plane)
- `src/services/` — capture / search / transform internals (not public verbs)
- `src/ports/` — `DocumentStore` / `SourceProvider` + fakes
- `src/core/` — embed/rerank clients, merge, arktype schemas
- `src/db/` + `migrations/` — Drizzle schema + SQL migrations (pgvector, `memory.*`)
- `packages/` — removed; DocumentStore adapters and Linear tools are sibling packages
  (`@corbits/mem0-memory-adapter`, `@corbits/supermemory-memory-adapter`,
  `@corbits/linear-tools`).

## Non-negotiable invariants

1. **Authenticate nothing.** Identity defaults to `c.get("principal")` from
   the Interchange context; a host may instead supply `callerResolver`
   (`src/routes/deps.ts`) to resolve a non-browser caller (e.g. a
   workflow-run child's own sidecar bearer token) — but resolving that
   token is 100% host logic, called through the seam, never implemented
   here. Either way authorization goes through the host's grant store
   (`@intx/authz`) via the same `requireGrant` path. Never add API keys,
   sessions, or OAuth here.
2. **One Postgres**: `DATABASE_URL`, the engine's own vector plane, under the
   `memory` schema — never the host's control-plane DB. No foreign keys into
   control-plane tables; cross-refs (`tenant_id`, `principal_id`) are plain
   `text`.
3. **Never embed in-process.** Embedding/reranking are outbound HTTP calls to
   configured endpoints. A model endpoint is a trusted URL, same as the
   database URL — no self-host flags, no SSRF filtering here.
4. **Validate at the edges with arktype** — route bodies and model-endpoint
   responses. Keep the version range compatible with Interchange's catalog
   (currently `^2.1.29`).

## Docs

- `PRODUCT.md` — what this is and what is out of scope (read first)
- `ARCHITECTURE.md` — why an SDK, design decisions
- `IMPLEMENTATION.md` — env vars, data model, service internals

Keep all three current when behavior changes (`/scribe` maintains them).
License is LGPL-2.1 (`LICENSE`); contributions go through `CLA.md`.
