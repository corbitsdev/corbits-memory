# Corbits Memory — Product shape

Memory for Interchange hubs: durable documents, hybrid search, recent list.

**You mount it on the hub (~5 lines). That exposes protected routes. Agents
and ingestion modules call those routes.** Capture (`add`) writes; search
retrieves. Workbench and coding agents are clients — not owners of auth.
Inference stays host-injected. Deployed agents do **not** git-install this
package: they carry `@corbits/memory/sidecar-bundle` and hit the parallel
`mountWorkflowMemory` routes.

## Default pipeline (locked)

```text
add  →  ingest elements  →  process (optional)
```

| Stage               | Meaning                                                         | Where                                                                 |
| ------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| **add**             | Something arrives (agent tool, host job, webhook body)          | Caller → `memory.add` / `POST …/memory/add`                           |
| **ingest elements** | Normalize → raw capture → chunks / edges → embed → search-ready | Default `DocumentStore` capture path (sync on `add`)                  |
| **process**         | Optional brain work: classify, claims, links, forget            | Host workflow / injected inference — same run as ingest when possible |

Preferred host shape: **one ingest workflow** receives the event, calls `add`
(ingest elements), then runs process steps in the same body (or a child step).
No pull feed required on that path — the workflow already has the payload.

**Pull feed + resident distiller** are optional: multi-writer backfill, replay,
or polish when other code also `add`s outside the ingest workflow. See
`docs/DISTILLER.md` and `docs/FEED.md`.

## Shape (locked)

**`src/` is the `@corbits/memory` SDK.** Interchange is the hub — the SDK
never creates one; it mounts onto yours.

| Surface                                                  | Role                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `createMemory({ … })`                                    | Build the plane                                                       |
| `createMemoryRoutes({ memory, requireGrant })`           | Hono sub-app the host mounts at `/api/tenants/:tenantId/memory`       |
| `mountWorkflowMemory(app, { memory, agentToken })`       | Parallel run-scoped `/api/workflow-memory/*` for deployed agents      |
| `loadMemoryConfig()`                                     | Config from env                                                       |
| `runMemoryMigrations(dbConfig, { schema, ftsLanguage })` | Apply pgvector schema                                                 |
| `@corbits/memory/sidecar-bundle`                         | Deployed-agent factory — no client code, no base URL, no token        |
| `@corbits/memory/distiller`                              | Optional process helpers: `runDistillTick`, `createResidentDistiller` |

### Verbs

| Method   | HTTP                                        | Grant           | Meaning                                                                             |
| -------- | ------------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `add`    | `POST /api/tenants/:tenantId/memory/add`    | `memory:add`    | Ingest: capture + derive (chunk/embed on default store)                             |
| `search` | `POST /api/tenants/:tenantId/memory/search` | `memory:search` | Hybrid retrieval (+ optional live sources); hits may include additive `attribution` |
| `list`   | `GET /api/tenants/:tenantId/memory/list`    | `memory:search` | Recent documents for the principal                                                  |
| `feed`   | `GET /api/tenants/:tenantId/memory/feed`    | `memory:search` | Cursor pull of new live versions (optional multi-writer / backfill)                 |

Engine-only plane helpers (no HTTP yet): transform/replay, retention
(`deprecateVersion` / `tombstoneDocument` / … — see `docs/RETENTION.md`),
share-grant materialization. Process helpers:
`createResidentDistiller` / `runDistillTick` (`docs/DISTILLER.md`) — host
injects inference; not the default ingest path.

Identity is always **`principalId` + `tenantId`** on the plane. Tenant HTTP
routes never take body identity — they read `c.get("principal")` from
Interchange context. Run-scoped sidecar routes read the verified workflow
run (`agentToken.verify` + `x-workflow-run-address`); the sidecar factory
never names a host or carries a token.

### How it is used

```
Agent / host ingest workflow
        │  tool call or host worker
        │  → POST|GET /api/tenants/:tenantId/memory/*
        │  authenticated by Interchange (session | API key | MCP OAuth)
        │
Deployed agent (sidecar-bundle)
        │  hub credential + run address
        │  → POST|GET /api/workflow-memory/*   (mountWorkflowMemory)
        ▼
┌──────────────────────────────────────────────┐
│  Host Interchange createApp                  │
│  principal + tenant on context               │
│  + createMemory({ grantStore, … })           │
│  + app.route(…, createMemoryRoutes(deps))    │
│       grants: memory:add | memory:search     │
│       documentStore: pgvector | host | fake  │
│  + mountWorkflowMemory(app, { memory, … })   │
│         │  in-process                        │
│         ▼                                    │
│  Memory plane: add (capture) / search / list │
│  → DocumentStore (sole durable backend)      │
└──────────────────────────────────────────────┘
```

1. **Mount** — host passes `app` + the same grant store it already uses.
2. **Sidecar (deployed agents)** — agents carry
   `@corbits/memory/sidecar-bundle`. It holds no client code, no base URL,
   and no token: it resolves the host `hub` credential and calls
   `/api/workflow-memory/*`. Host wires `mountWorkflowMemory` in parallel
   with the tenant routes (see README How it works). Not the primary
   install — that is still `createMemory` + `loadMemoryConfig`.
3. **Ingestion** — preferred: one host workflow (or module) does
   **add → ingest elements (capture) → process**. Mechanical capture is
   inside `add` on the default store; process (claims / links) is
   host-injected inference in the same pipeline when you want a company
   brain.

### Ports

| Port             | Purpose                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `DocumentStore`  | Sole durable backend for add/search/list (default: pgvector). Inject fakes or a host/adapter store to skip Postgres. |
| `SourceProvider` | Optional live search merge (fail-soft). Not a store replacement.                                                     |

Optional sibling packages (not in this tree): Mem0 / Supermemory document
stores, Linear tools. Core never imports vendor SDKs.

### What is not in scope

- No auth, API keys, OAuth, webhooks, SPA, or standalone server in core.
- No answer/generation endpoint — host owns inference.
- Workbench is a client, not required.
- Core does not run the ingest workflow process — the host does.
- Deployed agents do not git-install this package as a sidecar and do not
  receive a memory base URL or token — that is the sidecar-bundle contract.

**Default durable store:** Postgres via `DATABASE_URL`, tables under the
**`memory`** schema. When
`documentStore` is injected, Postgres is not opened. Cross-refs are plain
`text` — no FKs into the host control plane.

## Identity and access (one authz system)

Memory does not ship a second ACL. Document access uses the host’s
`@intx/authz` grant store.

1. **Capability** — may this principal use memory?
   `authorize(…, resource: "memory", action: "add" | "search")`.
2. **Document access** — each document carries **`accessTags`**. A principal
   sees a document if they are the creator **or**
   `authorize(…, resource: <tag>, action: "search")` allows for any tag.
3. **Share sugars on add** — mint tags only (owner / tenant / peers /
   explicit). Host must still grant peers `search` on the relevant tags.
   See `docs/AUTHZ-DOCUMENT-ACCESS.md`.

Default add is **owner-only**. Deny is absence of allow — not a document
block list.

### On the wire

```http
POST /api/tenants/:tenantId/memory/add      { "title", "text", "access_tags"?, "share"? }
POST /api/tenants/:tenantId/memory/search   { "query", "limit?", "kinds"?, "entity_ids"?, "sources"?, "includeEvidence"? }
GET  /api/tenants/:tenantId/memory/list     ?limit=
```

### Live sources

Local documents are grant-tagged. Live `SourceProvider` hits merge as
enrichment under the host’s connector tokens (fail-soft, no grant tags).

## Out of scope forever here

Auth, OAuth for Linear, third-party account management, embedding models
in-process, and any standalone process entrypoint.
