# Security — PR #31 round 2 (HEAD `6189b56`)

## Summary

Tenant isolation on SQL paths is generally solid (tenant_id first; grant post-
filter). No auth in package (by design). One correctness issue can cause
hard-fail (DoS of entity-filtered dense search). Transform APIs are privileged
operations without built-in principal checks.

## Critical

None for classic IDOR/authz bypass found in this pass. Closest:

**C-adjacent:** Dense `entityIds` query references non-existent `knowledge_edge`
(`search.ts:537`) — availability/DoS of that code path, not data leak.

## High

1. **Transform promote/demote/run lack principal binding**
   (`memory.ts:751-798`, `transform.ts`). Anyone who can call the in-process
   plane with a tenantId can rewrite that tenant’s live generation and active
   embed model. Mitigation: host-only, no HTTP. **Requirement:** document that
   hosts must gate these like admin APIs; never expose unauthenticated.

2. **Shared embedding physical tables across tenants** (table name =
   `embedding_<modelKey>` only). Isolation is `WHERE tenant_id = $1` on every
   dense query. A missing tenant predicate on a future query is cross-tenant
   vector leak. Current dense SQL includes `e.tenant_id = $1 AND c.tenant_id = $1`.
   **Keep as permanent review invariant.**

## Medium

3. **Exclusive activate race** — two concurrent activates can briefly leave two
   active rows; resolve picks latest updated_at. Unlikely privilege issue;
   wrong model for search is integrity issue.

4. **Share grants use `origin: "system"`** (`share-grants.ts:92`) with
   always-true condition evaluator. Correct for not fail-closing, but grants
   look “system-minted.” Audit trail relies on `conditions.memoryShare` payload.
   Ensure host UIs show that payload.

5. **Promote activate-before-swap window** — dense points at new model while
   live versions still old (or reverse on demote). Transient wrong hits, not
   cross-tenant.

6. **`appendAccessTags` optional** — if missing, peer grants may not match tags;
   peers fail-closed (safe) but sharer believes share succeeded.

## Low

7. Model endpoint URLs trusted by design (AGENTS.md) — no SSRF filter. Host
   responsibility.
8. Dynamic SQL for embed table names validated by `EMBED_TABLE_NAME_PATTERN` /
   modelKey hex — good.
9. Dynamic `dims` interpolated only after integer bounds check — good.

## Recommended fixes

| # | Fix |
|---|-----|
| 1 | `"memory"."edge"` in dense entity SQL + test |
| 2 | Doc: transform APIs are privileged; host grant required |
| 3 | Optional: single-transaction exclusive activate |
| 4 | Optional: return share materialization receipt to caller |

## Attack scenarios checked (no exploit)

- Cross-tenant document via search without grants → post-filter + tenant SQL.
- Embed table name injection → pattern reject.
- Promote another tenant’s generation → tenantId filter on transform_run;
  config tenant mismatch check on promote.
- Share grant self-grant → skipped when peer === sharedBy.
