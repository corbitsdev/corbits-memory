# Resident distiller (CL-5869)

The **resident distiller** is a host workflow (Interchange `onTrigger`), not a
process inside this package. Memory exposes the **substrate** only:

| Substrate | Where |
| --- | --- |
| Capture feed (exactly-once cursor) | `memory.feed` / `GET .../memory/feed` — [FEED.md](./FEED.md) |
| Claim-bearing + provenance | version columns — claim-bearing schema |
| Temporal classes | [TEMPORAL.md](./TEMPORAL.md) |
| Corroboration / living relevancy | [RELEVANCY.md](./RELEVANCY.md) |
| Transform / staged replay | `runTransform` / promote / demote |
| Share grants | `share.principals` → WritableGrantStore |

## Recommended body shape

1. **Pull** — `feed({ after: cursor, excludeGenerator: "resident-distiller" })`
2. **Classify / gate** — host policy (action-authority, kinds, poison skip)
3. **Distill** — host LLM; write via `add` with `createdByKind: agent`,
   `generatorAgentId: "resident-distiller"`, provenance `inferred` as needed
4. **Link** — supports/contradicts edges (host or future write API)
5. **Advance cursor** — store `nextCursor` only after successful handling
   (or after fail-soft poison quarantine)

Loop-safety: always pass `excludeGenerator` matching the distiller’s
`generatorAgentId` so the feed never re-delivers the distiller’s own writes.

## Out of scope here

- Deploying the workflow, model choice, grant manifest contents beyond tags
- Push outbox (phase 2 of the feed — still pull-only)
- Automatic edge minting on add

See `dispatch/resident-memory-distillation/5a-distiller_workflow/plan.md`.
