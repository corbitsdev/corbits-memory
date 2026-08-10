# Greybeard — PR #31 round 2 (HEAD `6189b56`)

## Verdict

**HOLD for one correctness fix; then ship foundation.** Architecture of
ensure-vs-activate, claim-bearing, temporal classes, and share materialization
is sound. Schema rename + DATABASE_URL is the right long-term shape.

## Ship / hold

**Hold** until dense `entityIds` SQL is fixed (`knowledge_edge` → `"memory"."edge"`).
After that: **ship with follow-ups** (promote E2E tests, exclusive activate
transaction, host authz docs for transform).

## Critical / High

1. **Raw SQL residue after schema rename** — `search.ts:537` `knowledge_edge`.
   Irreversible-looking renames that leave one path broken are worse than no
   rename: green CI + red prod.

2. **Fresh-install-only schema rename** is honest in CHANGELOG but operationally
   harsh. Acceptable for pre-1.0 / no prod tenants; document a one-shot
   `ALTER SCHEMA knowledge RENAME TO memory` + table renames for anyone who
   already migrated under `knowledge`.

## Medium — design debt (acceptable for now)

3. **JS identifiers lag schema** (`knowledgeDocument` table → `document`). Fine
   if intentional transitional; pick a rename PR later — do not half-rename.
4. **Embedding tables keyed only by model_key**, multi-tenant rows inside.
   Tenant filter on every dense query is load-bearing; keep that invariant in
   review checklist forever.
5. **Promote activate-then-swap** preference is documented and reasonable.
   Prefer advisory lock per tenant around promote/demote before multi-tenant
   production load.
6. **Docs generally lockstep** with DATABASE_URL / memory schema after last
   commit; IMPLEMENTATION table and AGENTS.md match. CHANGELOG “Previously”
   still contradicts versionId on add.

## Doc drift

| Claim | Reality |
|-------|---------|
| CHANGELOG: add returns `{ documentId }` | Returns `{ documentId, versionId }` |
| Comments: knowledge.embed_model | Table is memory.embed_model |
| open.type "memory" | Correct in search.ts |

## Design decisions that aged well

- `ensureEmbedModel` vs `activateEmbedModel` split (replay must not steal live).
- `activateEmbedModelByKey` for demote without re-probe.
- `archived_live_model_key` on transform_run.
- Share grants + pass-through condition registry.
- Enum lockstep test (enums.lockstep.test.ts).

## Recommendation

Fix Critical SQL → add dense+entityIds test → optional promote E2E → merge.
Do not block on knowledge* TypeScript renames.
