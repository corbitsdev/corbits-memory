# Temporal model

How `memory.version` times and ranking classes work. Implementation lives
in capture (write), hybrid-search (rank), and search/timeline (query filters).

## Four times (two stored, two derived)

| Concept | Column / source | Meaning |
| --- | --- | --- |
| **Effective time** | `occurred_at` (required) | When the content *refers to*: event moment, state effective time, or when a deadline was established. Not dual-meaning — one meaning applied across classes. |
| **Ingestion / assertion** | `ingested_at` | When the memory plane learned the content (capture or distill write). There is no separate `asserted_at`. |
| **Validity start** | `valid_from` (nullable) | Optional window start for state/deadline claims. |
| **Validity end** | `valid_until` (nullable) | Optional window end. Required in practice for useful `deadline` ranking. |

## `temporal_class`

SSOT: `TEMPORAL_CLASSES` in `src/core/enums.ts`. Stored on **version** (not
document) so successive versions can change class.

| Class | Recency prior | Notes |
| --- | --- | --- |
| `event` | Exponential decay from `occurred_at` (30-day half-life default) | Default for raw captures; preserves pre-model ranking. |
| `deadline` | Neutral far out; urgency ramp in a 7-day lookahead before `valid_until`; floor (0.7) after expiry | Still history-retrievable after expiry — not deleted. |
| `state` | Constant 1.0 while `status='active'` | Default for `provenance='inferred'` (distilled claims). Supersede via capture status, not recency. |
| `lesson` | Constant 1.0 | Always explicit; never a default. |

Defaults at write:

- Explicit `AdaptedDocument.temporalClass` wins.
- Else if `provenance === 'inferred'` → `state`.
- Else → `event`.

## Ranking integration

`applyBoosts` in `src/services/search.ts` multiplies the fused score by
`authorityBoostMultiplier × temporalRecencyMultiplier`. Lexical and dense
candidate queries both select `temporal_class` and `valid_until`.

Deadline formula (module constant `DEADLINE_LOOKAHEAD_MS = 7d`):

- `valid_until` null → 1.0
- remaining ≤ 0 → `BOOST_MULTIPLIER_MIN` (0.7)
- remaining ≥ lookahead → 1.0
- else ramp 1.0 → ~1.3 as the deadline approaches

## Timeline generation filter

Timeline joins only **active** versions in the requested **generation**
(default `live`). Replay-generation rows must not appear in the default
timeline (same rule as hybrid search).

## Supersedes

Unchanged: capture sets `status='superseded'` and `supersedes_version_id`
together. Temporal ranking does not write status. `state` “no decay until
superseded” means constant recency while active; superseded rows drop out of
live search/timeline via the status filter.
