# Retention classes (CL-5871)

Versions carry a **retention class** orthogonal to temporal ranking class
(`temporal_class`) and lineage (`source_class` / `provenance`).

| Class | Intent |
| --- | --- |
| `durable` | Long-lived claims; hard-delete blocked until tombstoned |
| `standard` | Default working memory |
| `ephemeral` | Short TTL; sweeper hard-deletes past `valid_until` (or 7d from `ingested_at`) |
| `source_only` | Keep raw capture; derived versions may be dropped by host policy |

Schema: `memory.version.retention_class` (migration `0007_retention.sql`).
CHECK constraint `version_retention_class_check` stays lockstep with
`RETENTION_CLASSES` in `src/core/enums.ts`.

## Write paths

| Verb | Plane API | Effect |
| --- | --- | --- |
| Deprecate | `memory.deprecateVersion` | `status=deprecated`, `deprecated_at` / reason |
| Tombstone | `memory.tombstoneDocument` | All active/deprecated/superseded versions → `tombstoned`; chunk text redacted to `[redacted]` |
| Hard delete | `memory.hardDeleteDocument` | Deletes document row (cascade); **refuses** if any non-tombstoned version is `durable` |
| Sweep | `memory.sweepEphemeral` | Auto-deprecates ephemeral versions past `valid_until` (or 7d from `ingested_at`); host schedules, core is cron-free |
| Set class | `memory.setRetentionClass` | Update `retention_class` on a version |

Search and feed exclude non-active (and non-superseded for feed) rows by
default. Pass `includeDeprecated: true` on search to retrieve deprecated
versions intentionally (ops / audit). Hard-delete is a separate explicit
verb — TTL never hard-deletes.

Service module: `src/services/retention.ts`.

## HTTP surface (CL-6288)

| Route | Grant action | Plane verb |
| --- | --- | --- |
| `POST …/memory/documents/:documentId/forget` | `memory:forget` | `tombstoneDocument` |
| `POST …/memory/documents/:documentId/purge` | `memory:purge` | `hardDeleteDocument` |
| `POST …/memory/versions/:versionId/retention-class` | `memory:forget` | `setRetentionClass` |

`deprecateVersion` and `sweepEphemeral` have no route (see below).

**Tombstone vs. hard delete stay distinct verbs, distinct grants.** A UI
offering "forget this" must never be one flag away from "shred this" by
accident. `forget` (tombstone) is the reversible-in-principle, audit-keeping
action; `purge` (hard delete) is the one that actually removes the row, has
its own grant action, and is refused outright while a `durable`-class version
on the document is untombstoned. A host can grant `forget` broadly (every
user gets a "forget this" button) while keeping `purge` to an operator role.

**Ownership, not just visibility.** `memory:search`/a document's `accessTags`
say who can *see* a document — never who may forget or purge it. Every
retention route additionally checks that the caller is the document's
creator (`created_by_principal_id` — the document's first version for
`forget`/`purge`, the specific version's own creator for `retention-class`),
independent of any share grant. A peer who can search a shared document gets
403 on `forget`/`purge`/`retention-class` for it. See
`src/services/retention-ownership.ts` and the ownership tests in
`src/memory.test.ts` / `src/routes/routes.test.ts`.

**`sweepEphemeral` stays off the HTTP surface.** It is a maintenance sweep —
"deprecate every ephemeral version past its TTL for this tenant" — not
something a single user requests about their own data, and it has no natural
per-caller grant (it does not take a `principalId` and touches every
matching row tenant-wide). A host that wants it schedules a cron job calling
`memory.sweepEphemeral({ tenantId })` in-process (the returned `Memory`
already exposes it); the engine stays cron-free per `ARCHITECTURE.md`.
