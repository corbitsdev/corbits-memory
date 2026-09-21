# @corbits/memory

Memory for Interchange hubs: **add**, **search**, **list**. Mount it on the
hub; routes land under `/api/tenants/:tenantId/memory/*` so the hub's
existing tenant middleware supplies principal + tenant. Host workers call
the same plane in-process. Inference stays host-owned — this package does
not ship an answer endpoint.

## Runtime support

Bun >= 1.2 runs the published TypeScript source (`package.json` `exports`);
there is no `dist` build, so native Node does not load it. `engines.node` is
`>=24` as a floor for Node-side tooling (typecheck, pack).

Peer stack you already have on an Interchange hub: `@intx/authz`,
`@intx/hub-api`, `hono`.

## Quickstart

```bash
npm add @corbits/memory
pnpm add @corbits/memory
yarn add @corbits/memory
bun add @corbits/memory
```

```ts
import { createMemory, loadMemoryConfig } from "@corbits/memory";

const memory = createMemory({
  app,
  config: loadMemoryConfig(), // DATABASE_URL + embed env
  grantStore,
  conditionRegistry,
});
```

That registers the tenant routes. Identity is `c.get("principal")` — bodies
never carry tenant or principal. Missing principal → 401. Missing grant →
403.

In-process, no HTTP and no Postgres — uses the exported fake store. Creator
always sees their own documents.

```ts
import { createMemory, createFakeDocumentStore } from "@corbits/memory";

const memory = createMemory({
  documentStore: createFakeDocumentStore(),
});

await memory.add({
  tenantId: "acme",
  principalId: "alice",
  content: {
    title: "Deploy notes",
    text: "Staging deploys run from main.",
  },
});

const { items } = await memory.search({
  tenantId: "acme",
  principalId: "alice",
  query: "staging",
});

console.log(items.map((item) => item.title));
```

On a real hub, omit `documentStore` and pass `config: loadMemoryConfig()`
(needs `DATABASE_URL`, `EMBED_BASE_URL`, `EMBED_MODEL`; see `.env.example`).
Apply migrations first:

```ts
import { runMemoryMigrations } from "@corbits/memory/migrations";

await runMemoryMigrations(process.env.DATABASE_URL!);
```

## How it works

`createMemory` builds the plane. Pass `app` to register
`/api/tenants/:tenantId/memory/*` behind `requireGrant("memory", …)` —
`grantStore` is required for that mount. `loadMemoryConfig` lives on the
barrel and at `@corbits/memory/config`.

Capability grants (`memory:add` / `memory:search` / `memory:forget` /
`memory:purge`) gate the routes. Per-document visibility is Interchange
grant tags on the row (`access_tags`); the creator always sees their own
docs. Details: [`docs/AUTHZ-DOCUMENT-ACCESS.md`](docs/AUTHZ-DOCUMENT-ACCESS.md).

Deployed agents do not install this package as a git sidecar. They carry
the factory at `@corbits/memory/sidecar-bundle`, which holds no client
code, no base URL, and no token: it resolves the host `hub` credential and
calls the run-scoped routes under `/api/workflow-memory/*`. That mount is
parallel to the tenant routes:

```ts
import { mountWorkflowMemory } from "@corbits/memory";

mountWorkflowMemory(workflowMemoryApp, {
  memory,
  agentToken: { verify, resolveRun },
});
app.route("/api/workflow-memory", workflowMemoryApp);
```

The resident distiller (`createResidentDistiller` / `runDistillTick`) is at
`@corbits/memory/distiller`.

## Development

```bash
git clone https://github.com/corbitsdev/corbits-memory.git
cd corbits-memory
bun install
bun run typecheck  # tsc --noEmit
bun run test       # bun test ./src
```

There is no `build` script — the published surface is `src/`.

## License

LGPL-2.1-only — see [`LICENSE`](LICENSE).
