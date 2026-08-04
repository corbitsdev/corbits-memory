# Corbits Knowledge Engine — Product shape

A **mountable knowledge plane** for Interchange hubs: durable documents, hybrid
search, grounded ask, and optional live sources / personal memory. Workbench and
coding agents are clients — not owners of ingestion or auth.

## Shape (locked)

**`src/` is the `@corbits/knowledge-engine` SDK.** Interchange is the hub — the
SDK never creates one; it mounts onto yours.

| Surface | Role |
| --- | --- |
| `mountKnowledgeEngine(app, opts)` | Plane + HTTP on an Interchange `createApp` |
| `createKnowledgePlane(config, grants?, options?)` | Same plane without HTTP |
| `runKnowledgeMigrations(url)` | Apply pgvector schema under Postgres `knowledge` |
| `loadKnowledgeConfig()` | Mount config from env |

### Green public plane (only these verbs)

| Method | Meaning |
| --- | --- |
| `add` | Capture a document (`content` **xor** `file` + TextExtractor) |
| `find` | Hybrid retrieval (+ optional live sources) |
| `ask` | Grounded answer from find (+ optional memory) |
| `recent` | Recent documents for the principal |

Hard cutover: there is no `capture` / `search` / `timeline` export. HTTP paths
and grants match the verbs: `POST /api/knowledge/add|find|ask`,
`GET /api/knowledge/recent`; grants `knowledge:add` and `knowledge:find`
(ask/recent share `find`).

Identity on the plane is always **`principalId` + `tenantId`** (never
`scopeId` / `subjectId`). HTTP routes never take body identity — they read
`c.get("principal")` from Interchange context.

### Ports (pluggable)

| Port | Purpose |
| --- | --- |
| `DocumentStore` | Durable local docs (default: engine pgvector) |
| `SourceProvider` | Optional live search (`searchLive`); merge is fail-soft |
| `MemoryProvider` | Optional personal memory (`remember` / `recall`) |

Mount options accept `documentStore`, `sources[]`, `memory`, plus in-package
**fakes** so a host can mount with fakes only and exercise add/find/ask/recent
without Postgres.

**MergeLocalLiveV1** merges local + live: fail-soft per provider (timeout/error
→ degrade flags, never fail the request), dedupe by `adapter:externalRef`,
optional `sources` filter (`local` + provider ids).

**Memory:** `includeMemory` on `ask` defaults **false**. When true and a
provider is mounted, recall injects uncited personal context; failures degrade
with `memory_unavailable` (docs-only). Writes are host-owned via
`plane.remember` — ask never auto-writes.

### Adapter packages (same monorepo tree)

| Package | Role |
| --- | --- |
| `@corbits/knowledge-adapter-mem0` | MemoryProvider; user id `tenantId::principalId` |
| `@corbits/knowledge-adapter-supermemory` | MemoryProvider; container `t_{tenant}_u_{principal}` |
| `@corbits/knowledge-source-linear` | SourceProvider + webhook → AdaptedDocument mappers |

Core never imports vendor SDKs. Adapters are pure-fetch; tenant-safe keys only.

### What is not in scope

- No auth, API keys, OAuth, webhooks, SPA, or standalone server in core.
- No dual ACL / aspirational `source_acl` writes as a security boundary.
- Workbench is a client, not required.

**One Postgres for the SDK:** `KNOWLEDGE_DATABASE_URL` only (no `DATABASE_URL`
fallback). All tables live under the **`knowledge`** schema
(`knowledge.document`, `knowledge.chunk`, …). Cross-refs (`tenant_id`,
`principal_id`) are plain `text` — no FKs into the host control plane.

```
Claude Code / Codex / Workbench (clients)
        │  authenticated by Interchange
        ▼
┌──────────────────────────────────────────────┐
│  Host Interchange createApp                  │
│  + mountKnowledgeEngine(app, opts)           │
│       grants: knowledge:add | knowledge:find │
│       optional: documentStore, sources,      │
│                 memory, textExtractor        │
│         │  in-process                        │
│         ▼                                    │
│  Knowledge plane: add / find / ask / recent  │
│  Postgres schema knowledge.* (pgvector)      │
└──────────────────────────────────────────────┘
```

## Identity and ACL ladder (honest)

1. **Capability** — host grant store: may this principal `knowledge:add` or
   `knowledge:find` at all?
2. **Document visibility** — modes `private` | `principals` | `tenant`
   (optional block list). Self-contained on the document row.
3. **Share sugars on add** — map to existing visibility; no new ACL system.

There is **no** dual grant path and **no** second secret ACL. If a connector
cannot prove a principal set, it must not write `tenant` visibility.

### On the wire

HTTP bodies are a thin subset of the in-process plane (identity always comes
from the host principal context, never the body):

```http
POST /api/knowledge/add      { "title", "text", "acl"? }
POST /api/knowledge/find     { "query", "limit?", "kinds?", "entity_ids?", "sources?", "includeEvidence?" }
POST /api/knowledge/ask      { "query", "limit?", "sources?", "includeMemory?" }
GET  /api/knowledge/recent   ?limit=
```

`kinds` / `entity_ids` on find narrow both lexical and dense channels before
fusion (unset or `[]` = no filter).

Plane-only shapes (`content`/`file` XOR, `share` sugars, full `visibility`)
are available via `createKnowledgePlane` / `plane.add`. HTTP `acl` maps to the
document visibility ladder; `share` is plane sugar only.

### Live sources and memory (trust)

- **Local documents** are the durable ACL plane (visibility + block). Engine
  path enforces this; a host-supplied `DocumentStore` **owns** ACL for that
  mount — the engine does not re-filter store results.
- **Live `SourceProvider` hits** merge into find/ask without document-row ACL.
  Auth is the host token / connector scope, not Interchange principal
  visibility. Treat live as enrichment; fail-soft on timeout/error.
- **Memory** is opt-in recall (`includeMemory`, default false). Adapters must
  key by injective tenant+principal encodings; ask never auto-writes memory.

## Out of scope forever here

Auth, OAuth for Linear, Mem0/Supermemory account management, embedding models
in-process, and any standalone process entrypoint.
