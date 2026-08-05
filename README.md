# @corbits/memory

Memory plane for [Interchange](https://github.com/corbitsdev) hubs:
**add** documents, **search** with hybrid retrieval, **list** recent events.

**One entry point:** `createMemory(options)`. Pass `app` to register
`/api/memory/*` on your Hono host. Without `app`, you get an in-process plane
only (CLI, worker, tests).

**Authenticates nothing.** Identity is `c.get("principal")` on HTTP; in-process
callers pass `principalId` + `tenantId`. Authorization is the host grant store
(`memory` resource + `add` / `search` actions via `@intx/authz`). Document access
uses grant tags on each row (`access_tags`); creator always sees their own docs.

**No baked-in LLM.** Inference is host-owned and ephemeral: call your model, then
`add` / `search`. Core does not mount an ingest agent or require `generate`.

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
//    Routes call requireGrant("memory", "add" | "search").
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
    id: "g-search",
    principalId: PRINCIPAL,
    resource: "memory",
    action: "search",
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
});

// 5. In-process path (CLI, worker, tests) — same plane, no second factory.
await memory.add({
  tenantId: TENANT,
  principalId: PRINCIPAL,
  content: { title: "Kickoff", text: "Ship memory 0→1 docs" },
});

const hits = await memory.search({
  tenantId: TENANT,
  principalId: PRINCIPAL,
  query: "memory docs",
});
console.log("search hits:", hits.items.length);

const events = await memory.list({
  tenantId: TENANT,
  principalId: PRINCIPAL,
});
console.log("list events:", events.length);

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

curl -sS -X POST http://127.0.0.1:8787/api/memory/search \
  -H 'content-type: application/json' \
  -d '{"query":"hello"}'

curl -sS 'http://127.0.0.1:8787/api/memory/list'
```

Clients never send tenant/principal in the body. Without principal middleware:
**401 `principal_required`**. Without the grant: **403**.

| Method | Path | Grant (`requireGrant`) |
| --- | --- | --- |
| POST | `/api/memory/add` | `("memory", "add")` |
| POST | `/api/memory/search` | `("memory", "search")` |
| GET | `/api/memory/list` | `("memory", "search")` |

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
});
```

### Inference (host-owned, ephemeral)

```ts
// Host extracts durable facts with its own model, then writes:
const facts = await hostGenerate(transcript);
for (const fact of facts) {
  await memory.add({
    tenantId,
    principalId,
    content: { title: fact.title, text: fact.text },
  });
}
// Host answers with retrieval + its own model:
const { items } = await memory.search({ tenantId, principalId, query });
const answer = await hostGenerate(buildPrompt(query, items));
```

There is no `ask` / `remember` / `recall` product path and no ingest agent in core.

## Hard cutover notes

| Old | New |
| --- | --- |
| `find` | `search` |
| `recent` | `list` |
| `ask` / `remember` / `recall` | removed (host-owned inference) |
| grant action `find` | `search` |
| `/api/memory/find` | `/api/memory/search` |
| `/api/memory/recent` | `/api/memory/list` |
| `/api/memory/ask` | removed |

## License

See repository.
