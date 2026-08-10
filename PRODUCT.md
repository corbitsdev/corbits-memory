# Corbits Memory — Product shape

Memory for Interchange hubs: durable documents, hybrid search, recent list.

**You mount it on the hub (~5 lines). That exposes protected routes. Agents
and ingestion modules call those routes.** Workbench and coding agents are
clients — not owners of ingestion or auth. Inference is host-owned (call your
model, then `add` / `search`); core does not ship an answer endpoint.

## Shape (locked)

**`src/` is the `@corbits/memory` SDK.** Interchange is the hub — the SDK
never creates one; it mounts onto yours.

| Surface | Role |
| --- | --- |
| `createMemory({ app, … })` | Register `/api/tenants/:tenantId/memory/*` + return the plane |
| `loadMemoryConfig()` | Config from env |
| `runMemoryMigrations(url)` | Apply pgvector schema |
| `registerMemoryRoutes` | Low-level HTTP only (optional) |
| `@corbits/memory/tools` | Interchange `defineTool` factories (`memory_add` / `memory_search` / `memory_list`) |

### Verbs

| Method | HTTP | Grant | Meaning |
| --- | --- | --- | --- |
| `add` | `POST /api/tenants/:tenantId/memory/add` | `memory:add` | Capture a document |
| `search` | `POST /api/tenants/:tenantId/memory/search` | `memory:search` | Hybrid retrieval (+ optional live sources); hits may include additive `attribution` |
| `list` | `GET /api/tenants/:tenantId/memory/list` | `memory:search` | Recent documents for the principal |
| `feed` | `GET /api/tenants/:tenantId/memory/feed` | `memory:search` | Cursor pull of new live versions (distiller) |

Engine-only plane helpers (no HTTP yet): transform/replay, retention
(`deprecateVersion` / `tombstoneDocument` / … — see `docs/RETENTION.md`),
share-grant materialization. Distiller is a **host** `onTrigger` workflow
using feed + add + attribution (`docs/DISTILLER.md`).

Identity is always **`principalId` + `tenantId`** on the plane. HTTP routes
never take body identity — they read `c.get("principal")` from Interchange
context.

### How it is used

```
Agent / ingestion module
        │  tool call or host worker
        │  → POST|GET /api/tenants/:tenantId/memory/*
        │  authenticated by Interchange (session | API key | MCP OAuth)
        ▼
┌──────────────────────────────────────────────┐
│  Host Interchange createApp                  │
│  principal + tenant on context               │
│  + createMemory({ app, grantStore, … })      │
│       grants: memory:add | memory:search     │
│       documentStore: pgvector | host | fake  │
│         │  in-process                        │
│         ▼                                    │
│  Memory plane: add / search / list           │
│  → DocumentStore (sole durable backend)      │
└──────────────────────────────────────────────┘
```

1. **Mount** — host passes `app` + the same grant store it already uses.
2. **Tools** — install `@corbits/memory/tools` (`defineTool` factories) on a
   workflow with env credentials (`memoryBaseUrl`, `memoryTenantId`,
   `memoryAuthToken`). Tools HTTP-call the mounted routes; identity is the
   hub-authenticated principal. OpenAPI→MCP remains an optional host bridge.
3. **Ingestion** — host modules (webhooks, batch jobs) call the routes or the
   returned plane with a resolved principal.

### Ports

| Port | Purpose |
| --- | --- |
| `DocumentStore` | Sole durable backend for add/search/list (default: pgvector). Inject fakes or a host/adapter store to skip Postgres. |
| `SourceProvider` | Optional live search merge (fail-soft). Not a store replacement. |

Optional sibling packages (not in this tree): Mem0 / Supermemory document
stores, Linear tools. Core never imports vendor SDKs.

### What is not in scope

- No auth, API keys, OAuth, webhooks, SPA, or standalone server in core.
- No answer/generation endpoint — host owns inference.
- Workbench is a client, not required.

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
