# Resident distiller

First-class on-ramp so a Corbits app can add memory **and** keep it distilled
without a sibling package.

## Quick start (Interchange workflow)

```ts
import { createResidentDistiller } from "@corbits/memory/distiller";
// or: import { createResidentDistiller } from "@corbits/memory";

const { workflow, generatorAgentId } = createResidentDistiller({
  inference: {
    sources: [{ provider: "openai", model: "gpt-4.1-mini" }],
  },
  // optional: cron: "*/5 * * * *", id, agentId, systemPrompt, extraTools
});

// Deploy `workflow` with host workflow-deploy.
// Env for tools: memoryBaseUrl, memoryTenantId, memoryAuthToken
// Grant the distiller principal: memory:search + memory:add (feed via search grant)
```

The agent is preloaded with `memory_feed`, `memory_add`, and `memory_search`.
System prompt encodes loop-safety (`exclude_generator` = `generatorAgentId`),
access-tag copy (never widen), and fail-soft poison handling.

## Quick start (imperative — any scheduler)

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

## Helpers

| Export | Use |
| --- | --- |
| `buildDistilledClaim` | Wire body with `generator_agent_id`, `provenance=inferred`, `derived_from` |
| `shouldProcessFeedEntry` | Skip own generator writes (defense in depth) |
| `resolveNextCursor` | Fail-soft cursor advance after poison |
| `RESIDENT_DISTILLER_AGENT_ID` | Default `"resident-distiller"` |

## Substrate (already on the plane)

| Piece | Where |
| --- | --- |
| Capture feed (exactly-once cursor) | `memory.feed` / `GET …/memory/feed` — [FEED.md](./FEED.md) |
| Claim identity on add | `generator_agent_id`, `provenance`, `lineage_class`, `derived_from` |
| Wire attribution on search | `SearchItem.attribution` |
| Retention / forgetting | [RETENTION.md](./RETENTION.md) |
| Tools | `@corbits/memory/tools` — `memoryAdd`, `memoryFeed`, `memorySearch`, `memoryList` |

## Grant manifest (host)

Minimum capabilities for the distiller principal:

- `memory:search` (covers feed pull under the same capability family hosts use today)
- `memory:add` (claim writes)

Copy `accessTags` from each feed entry onto writes — never mint broader tags.

## Out of scope

- Host deploy pipeline / secrets
- Push outbox (feed remains pull-only)
- Automatic supports/contradicts edge minting beyond `derived_from` on add
