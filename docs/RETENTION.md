# Retention classes (CL-5871)

**Status:** schema-ready design; write-path helpers land with 4b.

Versions may carry a **retention class** orthogonal to temporal ranking class:

| Class | Intent |
| --- | --- |
| `ephemeral` | Short TTL; auto-eligible for hard delete after window |
| `working` | Default working memory; soft deprecate then TTL |
| `durable` | Long-lived claims; deprecate/tombstone only on explicit write |
| `legal_hold` | Never auto-delete; operator-only release |

## Write paths (planned)

| Verb | Effect |
| --- | --- |
| `deprecate(versionId, reason)` | `status=deprecated`, set `deprecated_at` / reason |
| `tombstone(documentId)` | Hide from search/feed; retain row for audit |
| TTL sweeper | Host cron: hard-delete `ephemeral` past `valid_until` / retention window |

Search and feed already exclude non-active (and non-superseded for feed) rows;
retention classes refine *when* those transitions fire, not ranking math.

See `dispatch/resident-memory-distillation/4b-retention_forgetting/plan.md`.
