# Convergence review — PR #31 round 2 (HEAD `6189b56`)

**Method:** 8 deep lenses in-session (fleet spawn blocked: Codex profile
`fleur` unauthorized). Lenses: critique, greybeard, gaasbot, neckbeard,
bruckheimer, security, schema, OSS. Artifacts:
`.corbits/review-round2-*.md`.

## Converged verdict

**CHANGES REQUESTED — one hard blocker, then merge-eligible.**

All eight lenses agree the distillation foundation is the right shape and that
prior promote/demote/versionId work improved the bar. All eight that touched
search/schema flag the same ship-blocker.

---

## Must-fix before merge (unanimous / multi-lens)

| ID | Finding | Lenses | Action |
|----|---------|--------|--------|
| **M1** | Dense entity filter SQL still uses `knowledge_edge`; table is `"memory"."edge"` (`src/services/search.ts:537`) | critique, greybeard, gaasbot, neckbeard, security, schema, OSS, bruckheimer | Fix SQL + add regression test (dense path with entityIds) |
| **M2** | CHANGELOG Unreleased “Previously” claims add returns only `{ documentId }`; code returns `versionId` | critique, gaasbot, greybeard, OSS | Correct CHANGELOG |

## Should-fix (same PR if cheap; else ticket)

| ID | Finding | Lenses | Action |
|----|---------|--------|--------|
| **S1** | No promote/demote service E2E regression | critique, greybeard, gaasbot, bruckheimer | Add transform test: ensure→promote→demote restores model_key + generation |
| **S2** | search.test mocks still accept `FROM knowledge_embed_model` | neckbeard, OSS | Match only `"memory"."embed_model"` |
| **S3** | Document that transform/promote/demote are host-privileged (no principal on API, no HTTP) | security, gaasbot, greybeard | Short IMPLEMENTATION / AUTHZ note |

## Follow-up (do not block merge)

| ID | Finding | Lenses |
|----|---------|--------|
| F1 | `setActiveEmbedModelExclusive` two-step race | critique, security |
| F2 | Promote/demote multi-step windows; consider tenant advisory lock | critique, greybeard, security |
| F3 | Share fail-soft without WritableGrantStore / appendAccessTags — receipt field | critique, bruckheimer, security |
| F4 | TS `knowledge*` identifiers + migration filenames + comment rot | neckbeard, schema |
| F5 | Ops note for `ALTER SCHEMA knowledge RENAME TO memory` if any old install | greybeard, schema |
| F6 | README advanced surface (transform exports) | OSS, bruckheimer |

## Explicit non-goals this PR

- Distiller workflow / capture feed (CL-5868/5869)
- HTTP routes for transform
- Bulk rename of knowledge* TypeScript symbols
- Re-introducing separate knowledge DB

## Steelman of “merge as-is”

Tests are green; entityIds on dense may be rare; rename is fresh-install-only.
**Rejected:** a single untested raw-SQL island after a schema rename is exactly
the class of bug that survives CI and fails first real use. Fix is trivial.

## Steelman of “hold for promote E2E”

Demote is the safety valve for bad distillation. **Partial accept:** S1 is
high value but not a correctness hole in the current code path (demote restore
exists). Prefer same-PR if <1h; else ticket linked from PR.

## Converged fix order

1. **M1** fix + test  
2. **M2** CHANGELOG  
3. **S2** tighten mocks (with M1 test)  
4. **S1** if time  
5. **S3** one paragraph  
6. Re-run typecheck + test → push  

## Bar after fixes

| Bar | Status after M1+M2 |
|-----|--------------------|
| Security | Pass (with S3 doc preferred) |
| Product | Pass foundation |
| Greybeard / architecture | Pass |
| OSS quality | Pass pre-1.0 |
| Critique | Pass with S1 follow-up |

---

## Note on fleet

All 8 `task` spawns failed: `Codex profile "fleur" is not authorized`. Reviews
were executed in-session with the same multi-lens briefs. Re-auth `/model`
(profile fleur) to restore sub-agent fleet for future rounds.
