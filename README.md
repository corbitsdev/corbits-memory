# @corbits/memory

Mountable memory plane for [Interchange](https://github.com/corbitsdev) hubs:
**add** documents, **find** with hybrid search, **ask** grounded answers, **recent**
timeline — with optional live sources and personal memory.

**Authenticates nothing.** Identity is `c.get("principal")` on HTTP; in-process
callers pass `principalId` + `tenantId`. Authorization is the host grant store
(`memory` resource + `add` / `find` actions via `@intx/authz`). Never embeds
in-process — embedding and rerank are outbound HTTP to configured endpoints.

Requires Bun 1.2+.

## Install

Not published to npm yet. Install from git:

```bash
bun add git+https://github.com/corbitsdev/corbits-memory.git
bun add @intx/authz@0.2.2 @intx/hub-api@0.2.2 hono
```

## Quick start — complete mini app (no Postgres)

This is a full host you can run. It uses:

- Hono as the HTTP app
- `@intx/authz` in-memory grant store (same type as a real Interchange hub)
- in-package fakes for storage (no DB, no embed endpoints)
- principal + tenant middleware on `/api/memory/*` (required — these routes sit
  outside `/api/tenants/:tenantId/*`)

Save as `server.ts` and run with `bun run server.ts`.

```ts
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { createInMemoryGrantStore, type GrantRule } from "@intx/authz";
import {
  createFakeDocumentStore,
  createMemory,
  mountMemory,
} from "@corbits/memory";

const TENANT = "tenant_demo";
const PRINCIPAL = "principal_demo";

// 1. Capability grants the host would normally load from Interchange.
//    Routes call requireGrant("memory", "add" | "find").
const grantRules: GrantRule[] = [
  {
    id: "g-add",
    principalId: PRINCIPAL,
    resource: "memory",
    action: "add",
    effect: "allow",
    origin: "role",
    conditions: null,
    expiresAt: null,
    roleId: null,
  },
  {
    id: "g-find",
    principalId: PRINCIPAL,
    resource: "memory",
    action: "find",
    effect: "allow",
    origin: "role",
    conditions: null,
    expiresAt: null,
    roleId: null,
  },
];

const grants = {
  grantStore: createInMemoryGrantStore(grantRules),
  conditionRegistry: {}, // empty registry is fine when grants have no conditions
};

// 2. Durable store. Fakes prove the port boundary; swap for Postgres or a
//    sibling DocumentStore adapter later.
const documentStore = createFakeDocumentStore();

// 3. Hono app with principal + tenant on every request (Interchange shape).
const app = new Hono<TenantEnv>();

app.use("/api/memory/*", async (c, next) => {
  // In a real hub, session + tenant middleware set these.
  // Memory routes do NOT sit under /api/tenants/:tenantId/* — you must set them.
  c.set("principal", {
    id: PRINCIPAL,
    tenantId: TENANT,
    kind: "user",
    refId: "demo-user",
    status: "active",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  c.set("tenant", {
    id: TENANT,
    name: "Demo",
    slug: "demo",
    domain: "demo.local",
    parentId: null,
    config: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  await next();
});

// 4. Mount HTTP plane. Returns the same Memory object for in-process use.
const { memory } = mountMemory(app, {
  grants,
  documentStore,
  // optional: generate for ask(); textExtractor for add({ file })
  generate: async (messages) => {
    const last = messages.at(-1)?.content ?? "";
    return `demo answer for: ${last}`;
  },
});

// 5. In-process path (CLI, worker, tests) — same plane, no HTTP.
//    One options bag only. Never createMemory(undefined, …).
const plane = createMemory({
  grants,
  documentStore,
  generate: async () => "in-process answer",
});

await plane.add({
  tenantId: TENANT,
  principalId: PRINCIPAL,
  content: { title: "Kickoff", text: "Ship memory 0→1 docs" },
});

const hits = await plane.find({
  tenantId: TENANT,
  principalId: PRINCIPAL,
  query: "memory docs",
});
console.log("find hits:", hits.items.length);

const answer = await plane.ask({
  tenantId: TENANT,
  principalId: PRINCIPAL,
  query: "what should we ship?",
});
console.log("ask:", answer.answer);

// 6. HTTP
export default {
  port: 8787,
  fetch: app.fetch,
};

// Or: bun.serve({ port: 8787, fetch: app.fetch })
console.log("listening on http://127.0.0.1:8787");
```

Try the HTTP routes (principal is fixed by middleware above):

```bash
curl -sS -X POST http://127.0.0.1:8787/api/memory/add \
  -H 'content-type: application/json' \
  -d '{"content":{"title":"Note","text":"hello from curl"}}'

curl -sS -X POST http://127.0.0.1:8787/api/memory/find \
  -H 'content-type: application/json' \
  -d '{"query":"hello"}'

curl -sS -X POST http://127.0.0.1:8787/api/memory/ask \
  -H 'content-type: application/json' \
  -d '{"query":"what do we know?"}'

curl -sS 'http://127.0.0.1:8787/api/memory/recent'
```

Clients never send tenant/principal in the body. Without principal middleware:
**401 `principal_required`**. Without the grant: **403**.

| Method | Path | Grant (`requireGrant`) |
| --- | --- | --- |
| POST | `/api/memory/add` | `("memory", "add")` |
| POST | `/api/memory/find` | `("memory", "find")` |
| POST | `/api/memory/ask` | `("memory", "find")` |
| GET | `/api/memory/recent` | `("memory", "find")` |

## Production host (Postgres + real Interchange)

Same `mountMemory` call. Replace fakes and the demo grant store with the hub’s
real wiring:

```ts
import { mountMemory, loadMemoryConfig } from "@corbits/memory";

// Same grantStore + conditionRegistry you already pass to createApp /
// createRequireGrant from @intx/hub-api.
mountMemory(app, {
  config: loadMemoryConfig(), // needs KNOWLEDGE_DATABASE_URL + embed env
  grants: {
    grantStore: hubGrantStore,
    conditionRegistry: hubConditionRegistry,
  },
  // generate: wire to @intx/inference (or your own) for ask()
});
```

Env / migrations for the default pgvector store:

```bash
# KNOWLEDGE_DATABASE_URL required — no DATABASE_URL fallback
export KNOWLEDGE_DATABASE_URL=postgres://…
bun run db:setup
# or: runMemoryMigrations(process.env.KNOWLEDGE_DATABASE_URL)
```

Tables live under Postgres schema **`knowledge`**
(`knowledge.document`, `knowledge.version`, `knowledge.chunk`, …). Hard cutover
pre-1.0: re-run migrations on a fresh knowledge DB.

Mount middleware **before** `mountMemory` that sets `c.set("principal", …)` and
`c.set("tenant", …)` for `/api/memory/*` (session auth is still the host’s job).

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
vendor SDKs. Install each from git; each package README is a full 0→1 example.

| Package | Role |
| --- | --- |
| [`@corbits/mem0-memory-adapter`](https://github.com/corbitsdev/corbits-mem0-memory-adapter) | Mem0 as `documentStore` |
| [`@corbits/supermemory-memory-adapter`](https://github.com/corbitsdev/corbits-supermemory-memory-adapter) | Supermemory as `documentStore` |
| [`@corbits/linear-tools`](https://github.com/corbitsdev/corbits-linear-tools) | Linear **tools** (`SourceProvider` + webhook map) — not a store |

```ts
import { createMem0DocumentStore } from "@corbits/mem0-memory-adapter";

const memory = createMemory({
  documentStore: createMem0DocumentStore({ apiKey: process.env.MEM0_API_KEY! }),
  grants,
});
```

## Document access (grant tags)

1. Host capability grants (`memory` + `add` / `find`)
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
