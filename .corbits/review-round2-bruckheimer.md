# Bruckheimer — PR #31 round 2 (HEAD `6189b56`)

## One-liner

Foundation so a company-brain distiller can write **inferred claims** with
provenance, rank them in time, re-distill offline without trashing live search,
and share docs with real grants — not just tags.

## Hook progress

| Piece | Status for the hook |
|-------|---------------------|
| Claim-bearing / derived_from / provenance | Shipped |
| Temporal classes + validity | Shipped |
| Staged transform / promote / demote | Shipped (code); weak tests |
| Share grants materialization | Shipped (fail-soft without writable store) |
| Capture feed / distiller workflow | **Not this PR** (CL-5868/5869) |
| Schema/config host-friendly | DATABASE_URL + memory schema — good |

## Product blockers

1. **Dense entity filter broken after rename** — if any host/search UI filters by
   entity, dense path dies. Fix before merge.
2. **Promote rollback untested** — if demote is the safety valve for bad
   distillation, untested demote is a product risk, not just eng debt.
3. **Share without WritableGrantStore** only warns — hosts will think share
   “worked.” Consider fail-loud option or return receipt with
   `grantsMaterialized: false` (follow-up OK).

## Breaking-change cost/benefit

- `knowledge` → `memory` schema: right name for the product; cost is fresh
  install only. Acceptable if no production tenants on old schema.
- `DATABASE_URL` preferred: lowers host friction (one DB). Risk: host with two
  URLs silently picks the wrong one — document clearly (done in mount-config).

## Ship advice

Fix the dense SQL bug, clarify CHANGELOG on versionId, merge as foundation.
Do not hold the PR for the distiller itself. Next product milestone is feed +
workflow, not more schema polish.
