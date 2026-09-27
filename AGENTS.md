# AGENTS.md

## Purpose

`@corbits/memory` is a memory add / search / list SDK that mounts onto a host
Interchange app. It owns the `memory` Postgres schema (pgvector), capture,
hybrid search, retention and the optional distiller helpers. It does not own
authentication, grants, tenancy, or model inference: embedding and reranking
are outbound HTTP calls to configured endpoints. There is no server, port or
process entrypoint here, and there never should be.

## Layout

- `src/index.ts` — public surface: `createMemory`, `createMemoryRoutes`
- `src/mount-config.ts` / `src/config.ts` — mount config + engine config
- `src/routes/` — Hono routes (`add`, `search`, `list`, `feed`, retention
  `forget`/`purge`/`retention-class`)
- `src/workflow-mount.ts` — run-scoped routes for deployed agents (agent-token
  bearer + run address; no session auth)
- `src/sidecar-bundle.ts` + `src/tools.ts` — the agent tool bundle
  (`@corbits/memory/sidecar-bundle`) and its tool descriptors
- `src/http-client.ts` — host-side HTTP client for the tenant routes
- `src/services/` — capture / search / transform internals (not public verbs)
- `src/ports/` — `DocumentStore` / `SourceProvider` + fakes
- `src/core/` — embed/rerank clients, merge, arktype schemas
- `src/db/` + `migrations/` — Drizzle schema + SQL migrations (pgvector, `memory.*`)
- `src/distiller/` — optional process helpers (`@corbits/memory/distiller`)
- `docs/` — how access control, temporal ranking, relevancy, retention and the
  feed work; referenced from the code
- `e2e/` — real-Postgres suites

## Rules

1. **Authenticate nothing.** Identity defaults to `c.get("principal")` from
   the Interchange context; a host may instead supply `callerResolver`
   (`src/routes/deps.ts`) to resolve a non-browser caller (e.g. a
   workflow-run child's own sidecar bearer token) — but resolving that
   token is 100% host logic, called through the seam, never implemented
   here. Either way authorization goes through the host's grant store
   (`@intx/authz`) via the same `requireGrant` path. Never add API keys,
   sessions, or OAuth here.

   `ResolvedCaller` (the `callerResolver` return type) is frozen at exactly
   `{ tenantId, principalId }`. It carries no roles, no grants, no
   authorization hints of any kind — it is a shape conversion (host identity
   in, context principal/tenant out), never an authorization decision. A
   resolved caller traverses the identical `requireGrant`/`grantGuard` path a
   browser caller does and can never bypass it. Before widening this type —
   "let it carry roles too," "let a trusted caller skip `grantGuard`" — stop:
   either change turns the conversion shim into the library making an
   authorization decision, which IS the invariant this rule exists to name.
   If a host needs richer machine-caller authorization, that logic belongs in
   the host's own grant store / `callerResolver` closure, resolved down to
   `{ tenantId, principalId }` before it ever reaches this package — not in a
   wider `ResolvedCaller`.

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

## Local development

```sh
bun install && bun run check
```
