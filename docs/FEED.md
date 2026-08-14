# Capture feed

Stateless, cursorable pull of new **versions** for **optional** multi-writer
backfill / process workers (CL-5868).

**Default product path does not need this.** Prefer
**add → ingest elements → process** in one host pipeline (`PRODUCT.md`): the
workflow already has the payload, so no pull cursor.

Use the feed when:

- other agents or modules also `add` outside your ingest workflow
- you need catch-up / replay over a durable ordering key
- process is intentionally decoupled from the write (fail-soft polish)

## Phase 1 — pull (implemented)

```
memory.feed({ tenantId, principalId, after?, limit?, excludeGenerator? })
```

| Field | Meaning |
|-------|---------|
| `after` | Last consumed `feedSeq` (exclusive). Omit/0 = from start. |
| `limit` | Page size (bounded). |
| `excludeGenerator` | Skip versions with this `generator_agent_id` (loop-safe). |

- Ordered by `feed_seq` ascending (Postgres `bigserial` on `memory.version`).
- **Live generation only** — same rule as default search.
- Capability: `memory` / `search` (same as list/retrieve).
- Document access: grant-tag post-filter identical to search.
- **Cursor advances past the examined raw page**, even when the access filter
  returns zero entries. Using the last *allowed* `feedSeq` would stall a
  consumer on a fully denied page forever.

Cursor storage is the **consumer's** job (workflow run state).

HTTP: `GET /api/tenants/:tenantId/memory/feed?after=&limit=&exclude_generator=`

## Phase 2 — push (design only)

Post-commit outbox row keyed by `feed_seq` + host dispatcher that mails the
deployment address with version ids. **Not implemented** in core. Phase 1
`feed_seq` is the ordering key so Phase 2 is additive. Only relevant if process
stays out-of-band from the writer.

## Non-goals

- In-core cron or push dispatcher
- Bypassing grant tags for “tenant brain”
- Including replay generations in the default feed
- Replacing the default **add → ingest → process** host pipeline
