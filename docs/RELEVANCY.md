# Claim relevancy (corroboration)

Living relevancy for claim-bearing versions. Capture-time **`authority`** remains
a frozen snapshot (`computeAuthority` at write). Search derives a separate
**corroboration factor** from graph edges and multiplies ranking with it.

## Edges

| `rel` | Effect |
|-------|--------|
| `supports` | Independent source backs the target claim version — factor up |
| `contradicts` | Disagreement signal — factor down; **no** auto-delete/supersede |

Counts are edges with `to_type = 'version'` and `to_ref = <version id>`.
Writers (typically the resident distiller) attach `supports` / `contradicts`
hints on capture; core does **not** decide claim sameness.

## Ranking

`corroborationFactor({ supports, contradicts })` ∈ **[0.7, 1.3]** (same envelope
as authority/recency boosts). Neutral `1.0` when both counts are zero.

Effective authority for rank priors:

```
effectiveAuthority = clamp01(captureAuthority × corroborationFactor)
```

## Evidence: strong

After relevance floors clear, **strong** also requires:

1. Capture authority ≥ `AUTHORITY_STRONG_FLOOR` (0.3), and
2. Either:
   - `provenance: stated` + `created_by_kind: human`, or
   - support count ≥ `CORROBORATION_STRONG_FLOOR` (default **2**)

Constants live in `src/core/corroboration.ts`.

## Non-goals

- Embedding-similarity merge of claims
- Silent resolution of human disagreement
- Inference inside `@corbits/memory`
