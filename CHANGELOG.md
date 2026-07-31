# Changelog

All notable changes to `@corbits/knowledge-engine` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-07-31

### Added

- Grant-checked `ask()` on the knowledge plane: retrieves as the principal, grounds a host-supplied `generate` callback, returns citations (`#5`)
- Public `createKnowledgePlane` export for out-of-band capture and search (CLI seeders, batch ingesters, tests) without mounting HTTP routes (`#8`)

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
- Package install docs point at `@corbits/knowledge-engine` (`#6`)

### Fixed

- Rerank document truncation to fit cross-encoder token limits (`#10`)
- Degrade metrics: surface full rerank failure detail and count DegradeFlags so silent degradation is visible (`#11`)

## [0.1.0] — 2026-07

### Added

- Initial cut: mountable knowledge capture + search SDK for Interchange hubs

[0.1.2]: https://github.com/corbitsdev/corbits-knowledge-engine/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/corbitsdev/corbits-knowledge-engine/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/corbitsdev/corbits-knowledge-engine/releases/tag/v0.1.0
