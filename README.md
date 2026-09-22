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

Write the mount as a function that takes your hub's `app`, `grantStore`, and
`conditionRegistry` — the same trio you already pass to
`createRequireGrant`/`createApp`:

```ts
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import { createMemory, loadMemoryConfig, type Memory } from "@corbits/memory";

export function installMemory(
  app: Hono<TenantEnv>,
  grantStore: GrantStore,
  conditionRegistry: ConditionRegistry,
): Memory {
  const memoryApp = new Hono<TenantEnv>();
  const memory = createMemory({
    app: memoryApp,
    config: loadMemoryConfig(), // DATABASE_URL + embed env — see below
    grantStore,
    conditionRegistry,
  });
  app.route("/", memoryApp);
  return memory;
}
```

Mount `installMemory` below the middleware that sets `principal`/`tenant`
(a real hub's `createResolveTenant` on `/api/tenants/:tenantId/*` already
does). Identity comes from `c.get("principal")` — request bodies never
carry tenant or principal. Missing principal → 401, missing grant → 403.

Apply migrations before serving traffic:

```ts
import { runMemoryMigrations } from "@corbits/memory/migrations";

export async function migrateMemory(databaseUrl: string): Promise<void> {
  await runMemoryMigrations(databaseUrl);
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required to run memory migrations");
}
await migrateMemory(databaseUrl);
```

`loadMemoryConfig()` reads `DATABASE_URL` (required — tables live in a
`memory` Postgres schema, pgvector-capable) plus the embed pair:
`EMBED_BASE_URL`/`EMBED_MODEL` (OpenAI-compatible by default; `EMBED_API_KEY`
optional, `EMBED_API_STYLE`/`EMBED_TIMEOUT_MS` to override). Set both to
enable dense retrieval, or leave both unset to run lexical-only — full-text
search with no embed endpoint, a fully-supported mode rather than a degraded
one. Setting exactly one throws at load time. There is no credential-based
fallback: the embed pair is deployment config, resolved once per process
from the environment, the same for every tenant it serves. `RERANK_BASE_URL`/
`RERANK_MODEL`/`RERANK_API_KEY` are the equivalent optional pair for
reranking. See `.env.example` in this repo for the full list.

### Deployed agents (run-scoped routes)

A deployed agent authenticates with its own sidecar bearer token, not a
browser session, so it gets a second mount, scoped to the run rather than to
a tenant-session request:

```ts
import { Hono } from "hono";
import {
  mountWorkflowMemory,
  type Memory,
  type WorkflowMemoryEnv,
} from "@corbits/memory";

export function installWorkflowMemory(
  app: Hono<TenantEnv>,
  memory: Memory,
  agentToken: {
    verify: (
      ctx: unknown,
    ) => Promise<{ tenantId: string; definitionId: string } | undefined>;
    resolveRun: (runAddress: string) => Promise<{
      tenantId: string;
      principalId: string;
      runId: string;
    } | null>;
  },
): void {
  const workflowMemoryApi = new Hono<WorkflowMemoryEnv>();
  mountWorkflowMemory(workflowMemoryApi, { memory, agentToken });
  app.route("/api/workflow-memory", workflowMemoryApi);
}
```

`memory` here is the same plane `installMemory` built — one engine, two
mounts. The tool definitions a deployed agent calls against this mount ship
at `@corbits/memory/sidecar-bundle`.

## How it works

`createMemory` builds the plane. Pass `app` to register
`/api/tenants/:tenantId/memory/*` behind `requireGrant("memory", …)` —
`grantStore` is required for that mount. `loadMemoryConfig` lives on the
barrel and at `@corbits/memory/config`.

Capability grants (`memory:add` / `memory:search` / `memory:forget` /
`memory:purge`) gate the routes. Per-document visibility is Interchange
grant tags on the row (`access_tags`); the creator always sees their own
docs. Details: [`docs/AUTHZ-DOCUMENT-ACCESS.md`](docs/AUTHZ-DOCUMENT-ACCESS.md).

The resident distiller (`createResidentDistiller` / `runDistillTick`) is at
`@corbits/memory/distiller`.

### Lower-level: in-process calls, no HTTP

`app` is optional. Passing only `config` builds the plane without
registering routes, for a host worker that calls `add`/`search` directly
(the resident distiller does this):

```ts
import { createMemory, loadMemoryConfig } from "@corbits/memory";

const memory = createMemory({ config: loadMemoryConfig() });

await memory.add({
  tenantId: "acme",
  principalId: "alice",
  content: { title: "Deploy notes", text: "Staging deploys run from main." },
});

const { items } = await memory.search({
  tenantId: "acme",
  principalId: "alice",
  query: "staging",
});
```

Without `grantStore`, search/list fall back to creator-only visibility — a
safe default for a standalone caller, but not the shared-document behavior a
real tenant gets through `installMemory` above.

## Development

```bash
git clone https://github.com/corbitsdev/corbits-memory.git
cd corbits-memory
bun install
bun run typecheck  # tsc --noEmit
bun run test       # bun test ./src
```

Tests use `createFakeDocumentStore`/`createFakeSourceProvider` (exported for
this purpose) so the suite runs without Postgres. There is no `build`
script — the published surface is `src/`.

## License

LGPL-2.1-only — see [`LICENSE`](LICENSE).
