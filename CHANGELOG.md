# Changelog

All notable changes to `@corbits/memory` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** package and public surface renamed from `@corbits/knowledge-engine`
  to `@corbits/memory`. Public APIs: `mountMemory`, `mountMemoryRoutes`,
  `createMemory`, `loadMemoryConfig`, `runMemoryMigrations`, `Memory`,
  `MemoryConfig`, `MemoryError`. HTTP paths are under `/api/memory/`; grants are
  `memory:add` / `memory:find`; access tags use `memory.owner:` / `memory.tenant:`
  / `memory.space:`. Postgres schema name remains `knowledge`. See `MIGRATION.md`.
- **Breaking:** memory plane surface is `add` / `find` / `ask` / `recent` with
  `principalId` + `tenantId` only (`capture` / `search` / `timeline` and
  `subjectId` / `scopeId` removed). See `MIGRATION.md`.
- **Breaking:** HTTP routes are `POST /api/memory/add`,
  `POST /api/memory/find`, `POST /api/memory/ask`,
  `GET /api/memory/recent`. Old paths are not mounted.
- **Breaking:** grant actions are `add` and `find` (was `capture` / `search`).
  `ask` and `recent` use the `find` grant. Capability resource is `memory`.
- **Breaking:** `add` returns `{ documentId }`; find body uses `limit` (not `k`);
  find wire uses `items` (not `hits`).
- **Breaking:** document access is Interchange **grant tags** (`accessTags` +
  creator-always + host `GrantStore`), not the visibility-mode / block-list
  mini-ACL. Share sugar only mints tags. See `docs/AUTHZ-DOCUMENT-ACCESS.md`.
- **Breaking:** Postgres baseline is two files (`0001_extensions` +
  `0002_knowledge_baseline`) with `access_tags` and no `visibility_*` columns.
  Fresh installs only — drop/recreate the knowledge schema on existing DBs.
- **Breaking:** MemoryProvider side-channel option is `options.memoryProvider`
  (was `options.memory`).

### Added

- Optional `TextExtractor` + `file` XOR `content` on `add`
- `share` sugar on `add` (maps to access tags only: owner, tenant, peers)
- `access_tags` on `knowledge.document` (baseline schema; Postgres schema name unchanged)
- `POST /api/memory/ask` HTTP route
- `MIGRATION.md` hard-cutover notes for in-repo consumers

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
