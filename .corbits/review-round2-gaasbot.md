# Gaasbot (CTO) — PR #31 round 2 (HEAD `6189b56`)

## CTO verdict

**Right foundation, one ship-blocker.** This is the correct shape for
resident distillation: claim-bearing + temporal + staged transform + grants.
Do not expand scope into the distiller workflow (CL-5869) on this PR.

## Must-fix-before-merge

1. Fix dense-path `knowledge_edge` → `"memory"."edge"` (`search.ts:537`).
2. Add a regression test that would fail on that bug (dense fetch with
   entityIds, assert SQL contains `"memory"."edge"` or run against real SQL
   mock that only knows memory.edge).
3. Fix CHANGELOG: add returns `versionId`; remove contradictory “Previously”
   line or mark superseded.

## Can-ship-with-followups

- Promote/demote service-level tests.
- Tenant-scoped advisory lock on promote/demote.
- Atomic exclusive activate (single SQL CTE or transaction).
- Explicit “host authorizes transform APIs” note in IMPLEMENTATION.md.
- Rename TS `knowledge*` symbols in a dedicated PR (not this one).

## Defer

- HTTP routes for transform/promote (in-process is fine for v1 distiller).
- Capture feed (CL-5868), relevancy (CL-5867), retention (CL-5871).
- Upgrade migration from `knowledge` schema for old DBs unless a customer exists.

## Architecture notes

- Exporting transform + embed registry from package root is aggressive but OK
  for the distiller as first-party consumer. Keep them off HTTP until grants
  exist.
- Preferring `DATABASE_URL` is correct for “same Postgres, own schema.” Warn
  hosts that still set both URLs with different values — preferred wins.
- Do not re-introduce a separate knowledge DB requirement.

## Priority

Blocker fix is a one-liner + test. Merge after that; iterate on promote
hardening in the same branch if cheap, else follow-up ticket.
