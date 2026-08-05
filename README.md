# @corbits/memory

Memory plane for [Interchange](https://github.com/corbitsdev) hubs:
**add** documents, **find** with hybrid search, **ask** grounded answers, **recent**
timeline — with optional live sources and personal memory.

**One entry point:** `createMemory(options)`. Pass `app` to register
`/api/memory/*` on your Hono host. Without `app`, you get an in-process plane
only (CLI, worker, tests).

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

const grantStore = createInMemoryGrantStore(grantRules);
// Empty condition registry is fine when grants have no conditions.
const conditionRegistry = {};

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

// 4. One call: plane + HTTP routes. Returns Memory for in-process use too.
const memory = createMemory({
  app,
  grantStore,
  conditionRegistry,
  documentStore,
  // optional: generate for ask(); textExtractor for add({ file })
  generate: async (messages) => {
    const last = messages.at(-1)?.content ?? "";
    return `demo answer for: ${last}`;
  },
});

// 5. In-process path (CLI, worker, tests) — same plane, no second factory.
await memory.add({
  tenantId: TENANT,
  principalId: PRINCIPAL,
  content: { title: "Kickoff", text: "Ship memory 0→1 docs" },
});

const hits = await memory.find({
  tenantId: TENANT,
  principalId: PRINCIPAL,
  query: "memory docs",
});
console.log("find hits:", hits.items.length);

const answer = await memory.ask({
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

console.log("listening on http://127.0.0.1:8787");
```

Try the HTTP routes (principal is fixed by middleware above):

```bash
curl -sS -X POST http://127.0.0.1:8787/api/memory/add \
  -H 'content-type: application/json' \
  -d '{"title":"Note","text":"hello from curl"}'


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

Same `createMemory` call. Replace fakes and the demo grant store with the hub’s
real wiring. Register principal/tenant middleware **before** `createMemory({ app })`.

```ts
import { createMemory, loadMemoryConfig } from "@corbits/memory";

// Same grantStore + conditionRegistry you already pass to createApp /
// createRequireGrant from @intx/hub-api.
const memory = createMemory({
  app,
  config: loadMemoryConfig(), // needs KNOWLEDGE_DATABASE_URL + embed env
  grantStore: hubGrantStore,
  conditionRegistry: hubConditionRegistry,
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

## Ports

| Port | Default | Override |
| --- | --- | --- |
| `DocumentStore` | Engine pgvector | `options.documentStore` / `createFakeDocumentStore()` |
| `SourceProvider[]` | none | `options.sources` — live merge is fail-soft |
| `MemoryProvider` | none | `options.memoryProvider` / `createFakeMemoryProvider()` |

**Live merge (MergeLocalLiveV1):** per-provider timeout/error → `live_timeout` /
`live_error` degrade; dedupe `adapter:externalRef`; optional `sources` filter.

**Memory side-channel:** `ask({ includeMemory: true })` recalls when a provider
is set; failure → `memory_unavailable`, docs-only. `memory.remember` /
`memory.recall` for host-owned writes (ask never auto-remembers).

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
  grantStore,
  conditionRegistry,
});
```

## Document access (grant tags)

1. Host capability grants (`memory` + `add` / `find`)
2. Per-document **access tags** + creator rule (Interchange `@intx/authz`)
3. Share mints tags only — no visibility modes or block lists

See [docs/AUTHZ-DOCUMENT-ACCESS.md](./docs/AUTHZ-DOCUMENT-ACCESS.md).

## Compose routes yourself

Most hosts use `createMemory({ app, … })`. For custom route composition:

```ts
import { createMemory, registerMemoryRoutes, resolveGrantConfig } from "@corbits/memory";
import { createRequireGrant } from "@intx/hub-api";

const grantStore = hubGrantStore;
const conditionRegistry = hubConditionRegistry;
const grants = resolveGrantConfig({ grantStore, conditionRegistry })!;

const memory = createMemory({ grantStore, conditionRegistry, documentStore }); // no app
registerMemoryRoutes(app, {
  memory,
  grants,
  requireGrant: createRequireGrant(grants),
});
```

## License

LGPL-2.1-only
