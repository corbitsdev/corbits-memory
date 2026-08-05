# @corbits/knowledge-engine

Mountable knowledge plane for [Interchange](https://github.com/corbitsdev) hubs:
**add** documents, **find** with hybrid search, **ask** grounded answers, **recent**
timeline — with optional live sources and personal memory.

**Authenticates nothing.** Identity is `c.get("principal")` on HTTP; in-process
callers pass `principalId` + `tenantId`. Authorization is the host grant store
(`knowledge:add` / `knowledge:find`). Never embeds in-process — embedding and
rerank are outbound HTTP to configured endpoints.

Requires Bun 1.2+.

## Install

```bash
bun add @corbits/knowledge-engine
```

## Mount (green path)

```ts
import { mountKnowledgeEngine } from "@corbits/knowledge-engine";
import { loadKnowledgeConfig } from "@corbits/knowledge-engine/config";

mountKnowledgeEngine(app, {
  config: loadKnowledgeConfig(),
  grants: { grantStore, conditionRegistry },
  // optional ports:
  // documentStore, sources, memory, textExtractor, generate
});
```

Routes (each grant-checked):

| Method | Path | Grant |
| --- | --- | --- |
| POST | `/api/knowledge/add` | `knowledge:add` |
| POST | `/api/knowledge/find` | `knowledge:find` |
| POST | `/api/knowledge/ask` | `knowledge:find` |
| GET | `/api/knowledge/recent` | `knowledge:find` |

Clients never send tenant/principal in the body.

### Host must set principal on `/api/knowledge/*`

These routes sit outside `/api/tenants/:tenantId/*`. Mount middleware **before**
`mountKnowledgeEngine` that sets `c.set("principal", …)` and `c.set("tenant", …)`.
Without it: **401 `principal_required`**.

### Plane without HTTP

```ts
import {
  createKnowledgePlane,
  createFakeDocumentStore,
  createFakeMemoryProvider,
} from "@corbits/knowledge-engine";

const knowledge = createKnowledgePlane(undefined, grants, {
  documentStore: createFakeDocumentStore(),
  memory: createFakeMemoryProvider(),
  generate: async (messages) => "…", // wire your inference layer
});

await knowledge.add({
  tenantId,
  principalId,
  content: { title: "Note", text: "…" },
});
const hits = await knowledge.find({ tenantId, principalId, query: "…" });
const answer = await knowledge.ask({
  tenantId,
  principalId,
  query: "…",
  includeMemory: false, // default
});
```

## Ports

| Port | Default | Override |
| --- | --- | --- |
| `DocumentStore` | Engine pgvector | `options.documentStore` / `createFakeDocumentStore()` |
| `SourceProvider[]` | none | `options.sources` — live merge is fail-soft |
| `MemoryProvider` | none | `options.memory` / `createFakeMemoryProvider()` |

**Live merge (MergeLocalLiveV1):** per-provider timeout/error → `live_timeout` /
`live_error` degrade; dedupe `adapter:externalRef`; optional `sources` filter.

**Memory:** `ask({ includeMemory: true })` recalls when a provider is mounted;
failure → `memory_unavailable`, docs-only. `plane.remember` / `plane.recall` for
host-owned writes (ask never auto-remembers).

### Adapter packages

```ts
// packages/knowledge-adapter-mem0 — DocumentStore (not MemoryProvider)
import { createMem0DocumentStore } from "@corbits/knowledge-adapter-mem0";

// packages/knowledge-adapter-supermemory — DocumentStore
import { createSupermemoryDocumentStore } from "@corbits/knowledge-adapter-supermemory";

// Linear SourceProvider lives in sibling repo @corbits/linear
// (https://github.com/corbitsdev/corbits-linear), not this monorepo.
import {
  createLinearSourceProvider,
  mapLinearWebhook,
} from "@corbits/linear";
// host owns OAuth + webhook verify; private issues never map to tenant visibility
```

## Migrations

```bash
# KNOWLEDGE_DATABASE_URL required — no DATABASE_URL fallback
bun run db:setup
# or: runKnowledgeMigrations(process.env.KNOWLEDGE_DATABASE_URL)
```

All tables live under Postgres schema **`knowledge`**
(`knowledge.document`, `knowledge.version`, `knowledge.chunk`, …). Hard cutover
pre-1.0: re-run migrations on a fresh knowledge DB.

## ACL ladder (honest)

1. Host grants (`knowledge:add` / `knowledge:find`)
2. Per-document visibility (`private` | `principals` | `tenant` + optional blocks)
3. Share sugars on `add` map onto (2) — no second ACL system

## Docs

- `PRODUCT.md` — product shape and out-of-scope
- `ARCHITECTURE.md` — design decisions
- `IMPLEMENTATION.md` — env vars, data model, services
- `MIGRATION.md` — hard cutover from capture/search/timeline

## Develop

```bash
bun install
bun run typecheck
bun run test
# adapter packages (DocumentStore backends):
bun test packages/knowledge-adapter-mem0
bun test packages/knowledge-adapter-supermemory
# Linear tools: sibling repo @corbits/linear
```

License: LGPL-2.1 (`LICENSE`). Contributions: `CLA.md`.
