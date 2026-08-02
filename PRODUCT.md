# Corbits Knowledge Engine — Product shape

One product a team can run **without Workbench**: company brain for Claude Code,
Codex, and any other client. Workbench is a client, not the owner of ingestion
or auth.

## Shape (locked)

**`src/` is the `@corbits/knowledge-engine` SDK. Interchange is the hub — the
SDK never creates one; it mounts onto yours. Nothing else ships in this repo.**

1. **Public surface**: `mountKnowledgeEngine(app, opts)` drops the knowledge
   plane + routes onto an Interchange `createApp`;
   `createKnowledgePlane(config)` builds the same plane without mounting HTTP
   (CLI seeders, batch ingesters, tests);
   `runKnowledgeMigrations(url)` applies the pgvector schema;
   `loadKnowledgeConfig()` / `KnowledgeConfig` is the mount config.
2. **The SDK authenticates nothing.** Identity is the request principal, read
   off the Interchange context (`c.get("principal")`). Authorization uses the
   host's grant store via Interchange's `authorize` / `createRequireGrant`. No API keys, no
   sessions, no OAuth, no membership resolution — Interchange did all of that
   before the request reached a mounted route.
3. **Knowledge data plane runs in-process** against the host's knowledge/vector
   Postgres. No second server, no HTTP hop.

### What is not in scope

- No auth, no API keys, no OAuth, no webhook, no SPA, no standalone server.
  Those belong to the host (a reference deployment lives in
  `corbitsdev/examples`, not here).
- Workbench is **not** required. Workbench / Claude Code / Codex are **clients**.

**One Postgres for the SDK:** the knowledge / vector store (`pgvector`) — for
capture, hybrid search, raw corpus, replay. The host's control-plane DB (auth,
tenants, principals, grants, sessions) is entirely the host's concern.

```
Claude Code / Codex / Workbench (clients)
        │  authenticated by Interchange (session | API key | MCP OAuth)
        │  body: content (+ optional acl) — never tenant/principal
        ▼
┌──────────────────────────────────────────┐
│  Host Interchange createApp              │
│    resolves principal + tenant + grants  │
│  + mountKnowledgeEngine(app, opts)       │
│    or createKnowledgePlane(config)       │
│    reads c.get("principal") from context │
│    guards via host requireGrant(...)     │
│         │  in-process                    │
│         ▼                                │
│  Knowledge plane (capture / search)      │
│  store under scope_id + document ACL     │
│  search: scope first, then ACL match     │
│                                          │
│  Knowledge / vector Postgres (pgvector)  │
└──────────────────────────────────────────┘
```

## Identity and ACL

**The SDK does not authenticate.** Interchange authenticates the caller
(session, API key, or MCP OAuth) and puts `principal` + `tenant` on the request
context. Each mounted route reads identity from there:
`scopeId = principal.tenantId`, `subjectId = principal.id`. Clients never send
`tenant_id`/`principal_id` — the routes ignore body identity entirely.

Access is gated by the host's grant system: pass `grants` (the same
`{ grantStore, conditionRegistry }` you give `createApp`) to
`mountKnowledgeEngine`. HTTP routes run `requireGrant("knowledge", <action>)`
(`capture` for capture, `search` for search/timeline).
`createKnowledgePlane` builds the same plane without routes — callers acting
for a user must check the capability themselves (see README).

### On the wire

```http
POST /api/knowledge/capture     { "title", "text", "acl?" }
POST /api/knowledge/search      { "query", "k?", "kinds?", "entity_ids?" }
GET  /api/knowledge/timeline
```

Requests are authenticated upstream by Interchange (however the host chose);
the SDK routes assume a resolved principal on the context.

`kinds`/`entity_ids` narrow both the lexical and dense/semantic legs of
search before results are fused, so every hit matches the requested
kind/entity. An empty array on either field is equivalent to omitting it (no
filter), not "match nothing".

### Document ACL (who may surface on search/timeline) — set at capture

Optional on capture; default is scope-wide (the company brain), or
private-to-subject.

```ts
acl?: {
  mode: "scope" | "tenant" | "private" | "allowlist"
  allow?: string[] | { subjects?: string[] }   // subjects only for now
  block?: string[] | { subjects?: string[] }
}
```

Search and timeline both filter by scope first, then apply the document ACL
against the caller's subject. Block wins over allow. (Group/grant-based ACLs
are rejected until membership lands.) Timeline reads durable document state —
not a process-local capture ring — so ACL changes and restarts do not leak
titles. Each timeline event's `source` is the document adapter (HTTP capture
defaults to `"mcp"`; it is no longer hardcoded `"api"`), and `principalId` is
the capturing actor on the active version (`created_by_principal_id`), not the
caller of the timeline request.

## Ingestion

Ingestion is **capture** via the HTTP capture route, under the caller's context identity. (Expose it as an MCP tool with `@corbitsdev/hono-openapi-mcp`.)

External events (Linear, GitHub, …) come in the same way: the host authenticates
the forwarder to Interchange (e.g. an API key issued to the integration) and it
calls `POST /api/knowledge/capture`, or the host calls `knowledge.capture()`
directly from its own inbound handler. Vendor-payload mapping lives at the edge,
not in the SDK.


## Clients

| Client | How it talks to it |
| --- | --- |
| Claude Code / Codex | MCP + OAuth (or API key) on the host |
| Workbench | Generic tool client (not owner of ingest) |
| Humans | Host app's UI (sign-in, timeline) |

## Non-goals (this cut)

- Workbench owning ingestion or tenancy for the company brain.
- Client-supplied `tenant_id` / `principal_id` on the routes.
- Shipping without Interchange as control plane.
