# Critique — PR #31 round 2 (HEAD `6189b56`)

In-session (fleet blocked: Codex profile `fleur`). Diff `origin/main..HEAD`.
Typecheck clean; 367 tests green at last gate.

## Verdict

**CHANGES REQUESTED.** Prior promote/demote and versionId fixes landed, but the
`knowledge` → `memory` rename left a **live dense-path SQL bug**, and
promote/demote still lack end-to-end regression tests.

## Critical

1. **Dense entity filter still queries `knowledge_edge`**
   (`src/services/search.ts:537`). After schema rename, the table is
   `"memory"."edge"`. Any dense search with `entityIds` will fail at runtime
   (`relation "knowledge_edge" does not exist`). Lexical path is fine (Drizzle
   `knowledgeEdge` → `memory.edge`). No test exercises dense+entityIds.

## High

2. **No automated promote → demote → dense restore E2E.** Registry unit tests
   cover ensure/activate/byKey, but nothing asserts: staged run under model B
   does not flip live active; promote swaps generation + activates staged;
   demote restores generation **and** prior model_key. CL-5872 rollback
   acceptance still untested at the service layer.

3. **Promote/demote are multi-step outside a single transaction.** Activate
   dense, then version swap (or reverse on demote). Concurrent promote of two
   generations, or crash mid-window, can leave dense target and generation tags
   briefly inconsistent. Documented preference is intentional; still a
   production footgun without locks / single-flight.

## Medium

4. **`setActiveEmbedModelExclusive` is two non-atomic UPDATEs**
   (`embed-model-registry.ts:309-325`). Concurrent activate of A and B can
   leave two `active` rows until next exclusive call; `ORDER BY updated_at`
   picks one, but window exists.

5. **Transform plane methods take only `tenantId` / `configId` — no principal.**
   In-process API; no HTTP routes. Correct for library shape, but any host that
   re-exports without its own grant check hands promote/demote to any caller
   who can reach the plane. Docs should state “host must authorize.”

6. **Share path still fail-soft** when `appendAccessTags` or WritableGrantStore
   missing (`memory.ts:707-727`): warns, continues, peers fail-closed. Easy to
   miss in production.

7. **CHANGELOG drift:** Unreleased “Previously” still says `add` returns
   `{ documentId }` only; wire now returns `{ documentId, versionId }`.

## Low / Nits

8. Comments and enums still say `knowledge.version` / `knowledge.embed_model`
   (`enums.ts`, `embed-model-registry.ts:34`, `generation.ts`).
9. Migration file still named `0002_knowledge_baseline.sql` while creating
   `memory.*`.
10. TS exports still `knowledgeDocument` / `knowledgeVersion` under memory schema.

## Test gaps

- Dense search + `entityIds` (would catch Critical #1).
- `promoteGeneration` / `demoteGeneration` service tests with fake SQL + version rows.
- Concurrent exclusive activate (optional stress).
- `loadMemoryConfig` DATABASE_URL vs KNOWLEDGE preference already covered.

## Assumptions challenged

- “Rename was complete because migrations and drizzle use memory” — raw SQL
  island in dense path was not.
- “367 green ⇒ rename safe” — unit tests mock embed_model with dual match
  (`knowledge_embed_model` OR `memory.embed_model`) and never hit entity filter
  raw SQL.
