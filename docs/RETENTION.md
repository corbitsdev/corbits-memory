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
| Sweep | `memory.sweepEphemeral` | Hard-deletes documents whose ephemeral versions are past TTL |
| Set class | `memory.setRetentionClass` | Update `retention_class` on a version |

Search and feed exclude non-active (and non-superseded for feed) rows by
default. Pass `includeDeprecated: true` on search to retrieve deprecated
versions intentionally (ops / audit).

Service module: `src/services/retention.ts`.
