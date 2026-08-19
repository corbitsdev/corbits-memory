# Changelog

All notable changes to `@corbits/memory` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Retention HTTP routes (CL-6288): `POST …/memory/documents/:documentId/forget`
  (tombstone, grant `memory:forget`), `POST …/memory/documents/:documentId/purge`
  (hard delete, grant `memory:purge`), and
  `POST …/memory/versions/:versionId/retention-class` (grant `memory:forget`).
  Forget and purge are separate routes with separate grant actions — never one
  route with a boolean flag — and both are refused with 403 unless the caller
  is the document/version's creator, independent of any share grant that lets
  them merely see it. `sweepEphemeral` stays off the HTTP surface (maintenance
  sweep, not a user action); a host schedules it on its own cron against the
  in-process `Memory`. New `memory:forget` / `memory:purge` grant requirements
  (`source: "creator"`) and `capabilityIdsForSurface()` so distiller/tools
  installs no longer pick up routes-only capabilities by accident.
- `RouteDeps.callerResolver` / `createMemory({ callerResolver })` — an
  optional host-supplied resolver from a request to a `{ tenantId,
  principalId }` scope, for a caller that never goes through the host's
  tenant-session middleware (e.g. a workflow-run child authenticating with
  its own sidecar bearer token). Unset by default: every route still reads
  identity from `c.get("principal")` exactly as before. When set, the
  resolved identity is seated as the request's principal/tenant ahead of
  `grantGuard`, so the same `requireGrant` authorization path applies to a
  machine caller — never a separate, weaker one. Identity from the resolver
  always wins over anything a request body claims. The resolver's return
  value is parsed with arktype (non-empty `tenantId`/`principalId`); a
  resolver returning a malformed identity is rejected with `500` (a host
  bug), never seated as a garbage scope.

### Fixed

- `loadMemoryConfig` / `EngineConfig.embed` no longer requires an embed
  endpoint: a host with a pgvector Postgres and no embed endpoint now
  constructs and serves `add` + lexical `search`. Dense retrieval is skipped
  (not attempted-and-failed) and `search` reports
  `degraded: ["dense_unavailable", "lexical_only"]` so the state stays
  observable (CL-6287). **Migration note:** `dense_unavailable` is now also
  emitted on every search for a deliberately-unconfigured engine, not only on
  a transient dense-retrieval failure — a host with an existing alert rule
  keyed on `dense_unavailable` alone should also check for `lexical_only` in
  the same `degraded` array to distinguish "opted into lexical-only" from an
  actual regression.
- `add`'s `degraded` is now a reason array (`["embed_unavailable"]` and/or
  `["embed_unavailable", "lexical_only"]`), matching `search`'s shape —
  previously a bare boolean, which made it impossible to write one
  "is this response degraded" check across both verbs (CL-6287). **Breaking
  if a host coded against the boolean:** `degraded: true` is now
  `degraded: [...]`; check array presence/length instead of truthiness (both
  are still falsy/omitted when the document captured cleanly).
- `Memory.capabilities.embeddingsConfigured` (and the underlying
  `DocumentStore.capabilities`) let a host learn recall is lexical-only at
  construction time, without issuing a search first (CL-6287).
- Feed `nextCursor` advances past the examined raw page after grant-tag
  post-filter (a fully denied page no longer stalls the consumer forever).
- Distiller default system prompt uses the configured `agentId` for
  `exclude_generator` / `generator_agent_id` (not only the package default id).

### Changed

- **Product narrative:** default path is **add → ingest elements → process**
  (one host pipeline). Pull feed + `createResidentDistiller` are optional
  multi-writer / backfill process helpers, not the primary ingest story.
  See `PRODUCT.md`, `docs/DISTILLER.md`, `docs/FEED.md`.
- **Breaking:** Postgres schema renamed from `knowledge` to **`memory`**. Fresh
  installs only — drop/recreate the old schema (or rename) on existing DBs.
  Citation `open.type` is now `"memory"`.
- **Breaking:** env var is `DATABASE_URL` (was `KNOWLEDGE_DATABASE_URL`); pass
  `memory.databaseUrl` on config as an alternative. No deprecated alias.
- `add` (plane + HTTP) returns `{ documentId, versionId }` so share-grant audit
  and provenance can name the version that carried the write.
- Interchange `defineTool` factories at `@corbits/memory/tools` (`memory_add`,
  `memory_search`, `memory_list`) — HTTP clients for mounted hub routes with
  install env `memoryBaseUrl` / `memoryTenantId` / `memoryAuthToken`. Declared
  via `package.json` `interchange.tools` and `exports["./tools"]`.

### Previously

- **Breaking:** package and public surface renamed from `@corbits/knowledge-engine`
  to `@corbits/memory`. Public APIs: `createMemory` (optional `app` registers HTTP),
  `registerMemoryRoutes`.

  `createMemory`, `loadMemoryConfig`, `runMemoryMigrations`, `Memory`,
  `MemoryConfig`, `MemoryError`. HTTP paths are under
  `/api/tenants/:tenantId/memory/`; grants are
  `memory:add` / `memory:search`; access tags use `memory.owner:` / `memory.tenant:`
  / `memory.space:`. Postgres schema is `memory`.
- **Breaking:** config reads `DATABASE_URL` (was `KNOWLEDGE_DATABASE_URL`) for
  the engine's own pgvector Postgres connection.
- **Breaking:** memory plane surface is `add` / `search` / `list` with
  `principalId` + `tenantId` only. Inference is host-owned (no answer endpoint
  or personal-memory side-channel on the plane).

- **Breaking:** HTTP routes are `POST /api/tenants/:tenantId/memory/add`,
  `POST /api/tenants/:tenantId/memory/search`,
  `GET /api/tenants/:tenantId/memory/list` (inherits hub `resolveTenant`).
  Old unscoped `/api/memory/*` paths are not mounted.
- **Breaking:** grant actions are `add` and `search` (was `capture` / `find` /
  knowledge `search`). `list` uses the `search` grant. Capability resource is
  `memory`. Document-tag checks use action `search`.
- **Breaking:** `add` returns `{ documentId }`; search body uses `limit` (not `k`);
  search wire uses `items` (not `hits`).
- **Breaking:** document access is Interchange **grant tags** (`accessTags` +
  creator-always + host `GrantStore`), not the visibility-mode / block-list
  mini-ACL. Share sugar only mints tags. See `docs/AUTHZ-DOCUMENT-ACCESS.md`.
- **Breaking:** Postgres baseline is two files (`0001_extensions` +
  `0002_memory_baseline`) with `access_tags` and no `visibility_*` columns.
  Fresh installs only — drop/recreate the `memory` schema on existing DBs.
- **Breaking:** `grantStore` + `conditionRegistry` are top-level `createMemory`
  options (no nested `grants: { … }`).

### Added

- Optional `TextExtractor` + `file` XOR `content` on `add`
- `share` sugar on `add` (maps to access tags; principals also materialize
  grants when the host grant store is writable); `grantsMaterialized` on the
  add result when peers were requested
- `access_tags` on `memory.document` (baseline schema)
- Claim-bearing schema, temporal model, transform/replay, share grants
  (resident memory distillation foundation — CL-5865/5866/5872/5873)
- Living relevancy: corroboration factor from supports/contradicts edges;
  strong evidence gate (CL-5867). See `docs/RELEVANCY.md`
- Capture feed: `memory.feed` + `GET .../memory/feed` with `feed_seq` cursor
  (CL-5868). See `docs/FEED.md`
- **Wire attribution (CL-5870):** search hits carry additive `attribution`
  (versionId, provenance, source/temporal class, createdByKind,
  generatorAgentId, occurredAt/validUntil, corroboration counts, derivedFrom)
- **Retention (CL-5871):** `retention_class` on versions; plane APIs
  `deprecateVersion` / `tombstoneDocument` / `hardDeleteDocument` /
  `sweepEphemeral` / `setRetentionClass`; `includeDeprecated` on search.
  See `docs/RETENTION.md`
- **Resident distiller (CL-5869):** `@corbits/memory/distiller` —
  `createResidentDistiller({ inference })` schedule workflow + `runDistillTick`
  + `buildDistilledClaim`. Claim-aware `add` (generator_agent_id, provenance,
  derived_from, …). `memory_feed` tool. Feed entries include `accessTags`.
  See `docs/DISTILLER.md`

### Removed

- Host-injected generate path on the plane (use host inference + `add` / `search`)

## [0.1.2] — 2026-07-31

### Added
- Public `createMemory` export for out-of-band capture and search (CLI seeders, batch ingesters, tests) without mounting HTTP routes (`#8`)

### Fixed

- Fail-closed document ACL: withhold hits whose `acl_block` is unreadable or non-string (`#9`)
- Timeline titles use the same document ACL post-filter as search (`#12`)
- Return 401 (not 500) when the host has not resolved a principal (`#7`)
- ACL wiring tests mock `sql.unsafe` for FTS verification so the suite stays green under the search path

## [0.1.1] — 2026-07-31

### Added

- Halfvec expression indexes for embedding models above 2000 dimensions (up to 4000); dense search ORDER BY uses the same expression as the index (`#1`)
- Configurable lexical FTS language (`FTS_LANGUAGE` / `EngineConfig.ftsLanguage`) with parse, catalog verify, and rebuild recipe; public `DEFAULT_FTS_LANGUAGE` export (`#4`)
- Named chunk FK with `ON DELETE CASCADE` and composite tenant index on per-model embedding tables created at activation (`#3`)

### Changed

- Dense search scales `hnsw.ef_search` to the overfetch limit (floor 40) and probes `hnsw.iterative_scan = relaxed_order` once per process when available (`#2`)
- Package install docs point at `@corbits/memory` (`#6`)

### Fixed

- Rerank document truncation to fit cross-encoder token limits (`#10`)
- Degrade metrics: surface full rerank failure detail and count DegradeFlags so silent degradation is visible (`#11`)

## [0.1.0] — 2026-07

### Added

- Initial cut: mountable memory capture + search SDK for Interchange hubs

[0.1.2]: https://github.com/corbitsdev/corbits-memory/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/corbitsdev/corbits-memory/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/corbitsdev/corbits-memory/releases/tag/v0.1.0
