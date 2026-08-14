# OSS / public API quality — PR #31 round 2 (HEAD `6189b56`)

## Public surface inventory (package root)

- `createMemory`, `loadMemoryConfig`, `runMemoryMigrations`, `MemoryError`
- Routes: `registerMemoryRoutes`
- Ports: DocumentStore types, fakes, WritableGrantStore
- Share: buildShareGrants, materializeShareGrants, MEMORY_SHARE_*
- Transform: createTransformConfig, runTransform, promote/demoteGeneration, …
- Embed registry: ensure/activate/resolve helpers
- Degrade metrics, FTS helpers

**Note:** Transform + embed registry on the root export is a large surface for
an “add/search/list” product blurb. Acceptable for distiller-as-consumer;
README should mention advanced APIs.

## Breaking changes completeness

| Change | CHANGELOG | Code |
|--------|-----------|------|
| Schema knowledge → memory | Yes | Yes |
| DATABASE_URL preferred | Yes | Yes |
| open.type memory | Yes | Yes |
| add returns versionId | **Stale “Previously” says no** | Yes |
| Claim-bearing / temporal / transform | Partial (IMPLEMENTATION) | Yes |

## Quality bar

| Area | Pass? | Notes |
|------|-------|-------|
| arktype at edges | Pass | transform params, raw_capture replay |
| Enum lockstep tests | Pass | enums.lockstep.test.ts |
| Tenant SQL discipline | Pass* | *except broken edge table name |
| Module focus | Pass | services split reasonably |
| Docs match exports | Partial | CHANGELOG versionId; comments knowledge.* |
| Test coverage public contracts | Partial | no promote E2E; dense+entityIds missing |
| Semver honesty | Partial | fix Unreleased Previously section |

## Must-fix for OSS merge

1. Dense entity SQL table name.
2. CHANGELOG honesty on `MemoryAddResult` / wire body.
3. Regression test for (1).

## Nice-to-have before wider publish

- README section: transform/promote privileged, host-gated.
- Drop dual mock match for `knowledge_embed_model` in tests.
- Do not bulk-rename knowledge* TS identifiers in this PR.

## Verdict

**Fail OSS bar until Critical SQL + CHANGELOG; then pass for pre-1.0 foundation.**
