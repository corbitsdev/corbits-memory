# @corbits/memory

Mountable memory plane for [Interchange](https://github.com/corbitsdev) hubs:
**add** documents, **find** with hybrid search, **ask** grounded answers, **recent**
timeline — with optional live sources and personal memory.

**Authenticates nothing.** Identity is `c.get("principal")` on HTTP; in-process
callers pass `principalId` + `tenantId`. Authorization is the host grant store
(`memory:add` / `memory:find`). Never embeds in-process — embedding and
rerank are outbound HTTP to configured endpoints.

Requires Bun 1.2+.

## Install

Not published to npm yet. Install from git:

```bash
bun add git+https://github.com/corbitsdev/corbits-memory.git
```

## Mount

```ts
import { mountMemory, loadMemoryConfig } from "@corbits/memory";
import type { GrantStore, ConditionRegistry } from "@intx/authz";

// Same pair the host passes to createApp / createRequireGrant.
const grants = {
  grantStore: hostGrantStore as GrantStore,
  conditionRegistry: hostConditionRegistry as ConditionRegistry,
};

mountMemory(app, {
  config: loadMemoryConfig(),
  grants,
  // optional: documentStore, sources, memoryProvider, textExtractor, generate
});
```

Routes (each grant-checked):

| Method | Path | Grant |
| --- | --- | --- |
| POST | `/api/memory/add` | `memory:add` |
| POST | `/api/memory/find` | `memory:find` |
| POST | `/api/memory/ask` | `memory:find` |
| GET | `/api/memory/recent` | `memory:find` |

Clients never send tenant/principal in the body.

### Host must set principal on `/api/memory/*`

These routes sit outside `/api/tenants/:tenantId/*`. Mount middleware **before**
`mountMemory` that sets `c.set("principal", …)` and `c.set("tenant", …)`.
Without it: **401 `principal_required`**.

### Plane without HTTP

One options bag — never `createMemory(undefined, …)`.

```ts
import {
  createMemory,
  createFakeDocumentStore,
  createFakeMemoryProvider,
} from "@corbits/memory";
import type { GrantStore, ConditionRegistry } from "@intx/authz";

const grants = {
  grantStore: hostGrantStore as GrantStore,
  conditionRegistry: hostConditionRegistry as ConditionRegistry,
};

const memory = createMemory({
  grants,
  documentStore: createFakeDocumentStore(),
  memoryProvider: createFakeMemoryProvider(),
  generate: async (messages) => "…", // wire your inference layer for ask()
});

await memory.add({
  tenantId,
  principalId,
  content: { title: "Note", text: "…" },
});
const hits = await memory.find({ tenantId, principalId, query: "…" });
const answer = await memory.ask({
  tenantId,
  principalId,
  query: "…",
  includeMemory: false, // default
});
```

With the default Postgres store:

```ts
const memory = createMemory({
  config: loadMemoryConfig(),
  grants,
});
```

## Ports

| Port | Default | Override |
| --- | --- | --- |
| `DocumentStore` | Engine pgvector | `options.documentStore` / `createFakeDocumentStore()` |
| `SourceProvider[]` | none | `options.sources` — live merge is fail-soft |
| `MemoryProvider` | none | `options.memoryProvider` / `createFakeMemoryProvider()` |

**Live merge (MergeLocalLiveV1):** per-provider timeout/error → `live_timeout` /
`live_error` degrade; dedupe `adapter:externalRef`; optional `sources` filter.

**Memory side-channel:** `ask({ includeMemory: true })` recalls when a provider
is mounted; failure → `memory_unavailable`, docs-only. `plane.remember` /
`plane.recall` for host-owned writes (ask never auto-remembers).

### Optional DocumentStore adapters (sibling packages)

Optional backends are **sibling packages**, not vendored here. Core never imports
vendor SDKs. Install each from git; each README only documents itself + this core.

| Package | Role |
| --- | --- |
| [`@corbits/mem0-memory-adapter`](https://github.com/corbitsdev/corbits-mem0-memory-adapter) | Mem0 as `documentStore` |
| [`@corbits/supermemory-memory-adapter`](https://github.com/corbitsdev/corbits-supermemory-memory-adapter) | Supermemory as `documentStore` |
| [`@corbits/linear-tools`](https://github.com/corbitsdev/corbits-linear-tools) | Linear **tools** (`SourceProvider` + webhook map) — not a store |

```ts
import { createMem0DocumentStore } from "@corbits/mem0-memory-adapter";
// or: createSupermemoryDocumentStore from @corbits/supermemory-memory-adapter
// or: createLinearSourceProvider from @corbits/linear-tools

const memory = createMemory({
  documentStore: createMem0DocumentStore({ apiKey: process.env.MEM0_API_KEY! }),
  grants,
});
```

## Migrations

```bash
# KNOWLEDGE_DATABASE_URL required — no DATABASE_URL fallback
bun run db:setup
# or: runMemoryMigrations(process.env.KNOWLEDGE_DATABASE_URL)
```

All tables live under Postgres schema **`knowledge`**
(`knowledge.document`, `knowledge.version`, `knowledge.chunk`, …). Hard cutover
pre-1.0: re-run migrations on a fresh knowledge DB.

## Document access (grant tags)

1. Host capability grants (`memory:add` / `memory:find`)
2. Per-document **access tags** + creator rule (Interchange `@intx/authz`)
3. Share sugars on `add` only mint tags — no visibility modes or block lists

Full design: `docs/AUTHZ-DOCUMENT-ACCESS.md`.

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
```

License: LGPL-2.1 (`LICENSE`). Contributions: `CLA.md`.
