# Process helpers (distiller)

Default product path is **add → ingest elements → process** in one host
pipeline (`PRODUCT.md`). Mechanical ingest (raw → chunk → embed) already runs
inside `memory.add` on the default store.

This package’s distiller exports are **optional process helpers** for when
you need LLM claim extraction **outside** that single pipeline:

- multi-writer: other agents also `add` and you want a backfill worker
- replay / catch-up over a cursor
- fail-soft polish decoupled from the write that ingested the raw note

They are **not** the primary “how memory is ingested” story.

## Preferred: process in the same ingest workflow

```text
onTrigger / host job
  1. receive source event (or fetch)
  2. memory_add          // ingest elements
  3. process (optional)  // claims / links — same body or child step
```

No feed cursor required: the workflow already has the payload. Host injects
inference; tools only need `memory_add` / `memory_search` (and grants).

Helpers still useful in-process:

| Export | Use |
| --- | --- |
| `buildDistilledClaim` | Wire body with `generator_agent_id`, `provenance=inferred`, `derived_from` |
| `RESIDENT_DISTILLER_AGENT_ID` | Stable generator id if you write claims |

## Optional: multi-writer / backfill (`runDistillTick`)

When other writers also `add`, drain new versions with the capture feed:

```ts
import { runDistillTick } from "@corbits/memory/distiller";
import { createMemoryHttpClient } from "@corbits/memory/tools";

const client = createMemoryHttpClient({
  baseUrl: process.env.MEMORY_BASE_URL!,
  tenantId: process.env.MEMORY_TENANT_ID!,
  authToken: process.env.MEMORY_AUTH_TOKEN!,
});

let cursor = 0;
const result = await runDistillTick({
  client,
  after: cursor,
  distill: async (entry) => {
    // call your model — return skip | poison | write
    return {
      action: "write",
      title: "Claim",
      text: "…",
      temporalClass: "lesson",
    };
  },
});
cursor = result.nextCursor; // persist
```

Inference is **always injected** (`distill` callback or host agent sources).
The package never embeds a model.

## Optional: schedule workflow scaffold (`createResidentDistiller`)

Scaffold for hosts that still want a deployed agent with memory tools +
system prompt (loop-safety, access-tag copy). Prefer wiring **process next to
add** in your ingest workflow; use this for backfill-style residency only.

```ts
import { createResidentDistiller } from "@corbits/memory/distiller";

const { workflow, generatorAgentId } = createResidentDistiller({
  inference: {
    sources: [{ provider: "openai", model: "gpt-4.1-mini" }],
  },
});
// Deploy only if you need a multi-writer pull consumer — not default ingest.
```

## Substrate (plane)

| Piece | Where |
| --- | --- |
| Ingest on add | capture path — raw + chunks + embed |
| Capture feed (cursor) | `memory.feed` — [FEED.md](./FEED.md) (backfill / multi-writer) |
| Claim identity on add | `generator_agent_id`, `provenance`, `lineage_class`, `derived_from` |
| Wire attribution on search | `SearchItem.attribution` |
| Retention / forgetting | [RETENTION.md](./RETENTION.md) |
| Tools | `@corbits/memory/tools` |

## Grant manifest (process principal)

- `memory:add` (claim or note writes)
- `memory:search` (corroboration + feed if using backfill)

Copy `accessTags` from the source onto claim writes — never mint broader tags.

## Out of scope

- Host deploy pipeline / secrets
- Push outbox (optional later; not required if process is in-pipeline)
- Core-owned ingest workflow process (host owns that)
- Automatic supports/contradicts edge minting beyond `derived_from` on add
