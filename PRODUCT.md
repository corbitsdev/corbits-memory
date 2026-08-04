# Corbits Memory — Product shape

A **mountable memory plane** for Interchange hubs: durable documents, hybrid
search, grounded ask, and optional live sources / personal memory side-channel.
Workbench and coding agents are clients — not owners of ingestion or auth.

## Shape (locked)

**`src/` is the `@corbits/memory` SDK.** Interchange is the hub — the
SDK never creates one; it mounts onto yours.

| Surface | Role |
| --- | --- |
| `mountMemory(app, opts)` | Plane + HTTP on an Interchange `createApp` |
| `createMemory(config, grants?, options?)` | Same plane without HTTP |
| `runMemoryMigrations(url)` | Apply pgvector schema under Postgres `knowledge` |
| `loadMemoryConfig()` | Mount config from env |

### Green public plane (only these verbs)

| Method | Meaning |
| --- | --- |
| `add` | Capture a document (`content` **xor** `file` + TextExtractor) |
| `find` | Hybrid retrieval (+ optional live sources) |
| `ask` | Grounded answer from find (+ optional memory) |
| `recent` | Recent documents for the principal |

Hard cutover: there is no `capture` / `search` / `timeline` export. HTTP paths
and grants match the verbs: `POST /api/memory/add|find|ask`,
`GET /api/memory/recent`; grants `memory:add` and `memory:find`
(ask/recent share `find`).

Identity on the plane is always **`principalId` + `tenantId`** (never
`scopeId` / `subjectId`). HTTP routes never take body identity — they read
`c.get("principal")` from Interchange context.

### Ports (pluggable)

| Port | Purpose |
| --- | --- |
| `DocumentStore` | **The** durable backend for add/find/recent (default: engine pgvector, wrapped as a DocumentStore). Replace with any host `DocumentStore` or in-package fakes — no Postgres required when overridden. The plane is always store-backed; there is no second engine-only path. |
| `SourceProvider` | Optional **tools-shaped** live search (`searchLive`); merge is fail-soft. Not a store replacement. |
| `MemoryProvider` | Optional ask side-channel only (`includeMemory`); **not** how you swap backends. |

Mount options accept `documentStore`, `sources[]`, `memoryProvider`, plus in-package
**fakes** so a host can mount with fakes only and exercise add/find/ask/recent
without Postgres. Hosts that want a third-party durable backend implement
`DocumentStore` (or use an optional adapter package) and pass it as
`documentStore`, omitting `MemoryConfig` when Postgres is not needed.

**MergeLocalLiveV1** merges local DocumentStore + live SourceProviders: fail-soft
per provider (timeout/error → degrade flags, never fail the request), dedupe by
`adapter:externalRef`, optional `sources` filter (`local` + provider ids).

**Memory side-channel:** `includeMemory` on `ask` defaults **false**. When true
and a `MemoryProvider` is mounted, recall injects uncited personal context;
failures degrade with `memory_unavailable` (docs-only). This is unrelated to
replacing the DocumentStore. Writes via `plane.remember` are host-owned — ask
never auto-writes.

### Optional adapter packages

Optional `DocumentStore` implementations live under `packages/` in this tree
(or as separate packages). Core never imports vendor SDKs. Hosts that need a
store beyond default pgvector mount their own `documentStore`.

**Third-party store honesty:** not every `DocumentStore` evaluates host grant
tags. Some isolate by **principal bucket** only (one private namespace per
tenant+principal) and do **not** multi-share via `accessTags` + host
`GrantStore`. For full grant-tag ACL, use the default pgvector store (or a store
that implements the contract in `docs/AUTHZ-DOCUMENT-ACCESS.md`). Adapter
packages must document their isolation model in their own README. Never mount a
durable store as `options.memoryProvider`.

### What is not in scope

- No auth, API keys, OAuth, webhooks, SPA, or standalone server in core.
- No dual ACL / aspirational `source_acl` writes as a security boundary.
- Workbench is a client, not required.
- Linear / Granola / MCP tools are **not** DocumentStore replacements.

**Default durable store:** local Postgres via `KNOWLEDGE_DATABASE_URL` only (no
`DATABASE_URL` fallback), tables under the **`knowledge`** schema. When
`documentStore` is injected, Postgres is not opened. Cross-refs (`tenant_id`,
`principal_id`) on the default store are plain `text` — no FKs into the host
control plane.

```
Claude Code / Codex / Workbench (clients)
        │  authenticated by Interchange
        ▼
┌──────────────────────────────────────────────┐
│  Host Interchange createApp                  │
│  + mountMemory(app, opts)           │
│       grants: memory:add | memory:find │
│       documentStore: pgvector | host store │
│                      | fake                │
│       optional: sources, memoryProvider,     │
│                 textExtractor                │
│         │  in-process                        │
│         ▼                                    │
│  Memory plane: add / find / ask / recent     │
│  → DocumentStore (sole durable backend)      │
└──────────────────────────────────────────────┘
```

## Identity and access (Interchange authz — one system)

Memory does **not** ship a second ACL. Document access uses the host’s
`@intx/authz` grant store — the same grants/roles as the rest of Interchange.

1. **Capability** — may this principal use memory at all?
   `authorize(…, resource: "memory", action: "add" | "find")`.
2. **Document access** — each document carries **`accessTags`** (resource strings
   in grant-pattern space). A principal sees a document if they are the creator
   **or** `authorize(…, resource: <tag>, action: "find")` allows for any tag on
   the document. Patterns (`memory.space:*`) work via `@intx/authz`.
3. **Share sugars on add** — only mint tags (owner / tenant / peer owner tags /
   explicit tags). They do **not** invent visibility modes or block lists.
   **Host contract:** peers named in `share.principals` only see the doc if the
   host has granted them `find` on their owner tag (or matching pattern) —
   typically bootstrap every principal with `find` on `memory.owner:<self>`.
   Tag minting is not grant minting. See `docs/AUTHZ-DOCUMENT-ACCESS.md`.

Default add is **owner-only** (`memory.owner:<principalId>` + creator rule).
Deny is absence of allow (or a more specific host deny grant) — not a document
block list. Full design: `docs/AUTHZ-DOCUMENT-ACCESS.md`.

Third-party DocumentStores may be **principal-bucket** only and not evaluate
host grants; that limit belongs in the adapter's own docs, not hidden here.

### On the wire

HTTP bodies are a thin subset of the in-process plane (identity always comes
from the host principal context, never the body):

```http
POST /api/memory/add      { "title", "text", "access_tags"?, "share"? }
POST /api/memory/find     { "query", "limit?", "kinds?", "entity_ids?", "sources?", "includeEvidence?" }
POST /api/memory/ask      { "query", "limit?", "sources?", "includeMemory?" }
GET  /api/memory/recent   ?limit=
```

`kinds` / `entity_ids` on find narrow both lexical and dense channels before
fusion (unset or `[]` = no filter).

### Live sources and memory (trust)

- **Local documents** are grant-tagged; default engine evaluates tags via the
  host `GrantStore`. An injected `DocumentStore` owns enforcement for that mount.
- **Live `SourceProvider` hits** merge into find/ask without grant tags. Auth is
  the host token / connector scope. Treat live as enrichment; fail-soft.
- **Memory** is opt-in recall (`includeMemory`, default false). Adapters must
  key by injective tenant+principal encodings; ask never auto-writes memory.

## Out of scope forever here

Auth, OAuth for Linear, third-party memory/account management, embedding models
in-process, and any standalone process entrypoint.

