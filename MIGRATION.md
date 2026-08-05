# Migration guide — green API cutover (0.2.0)

Hard cutover. There is no dual-path or alias period. Hosts and grant tables must
move to the new names in the same release.

## Plane surface

| Was | Now |
| --- | --- |
| `knowledge.capture(params)` | `memory.add(params)` |
| `knowledge.search(params)` | `memory.find(params)` |
| `knowledge.timeline(params)` | `memory.recent(params)` |
| `knowledge.ask(params)` | `memory.ask(params)`; grant action changed (below) |

Identity fields on every call:

| Was | Now |
| --- | --- |
| `subjectId` | `principalId` |
| `scopeId` | `tenantId` |

### `add`

- Returns `{ documentId }` only (no `status` / `versionId` / `chunks` on the public result).
- Exactly one of `content: { title, text }` or `file: { bytes, mimeType?, filename? }`.
- File ingest requires a host-supplied `textExtractor` on the plane options.
- Optional `share` sugar (`tenant` / `principals` / `tags`) maps to **access tags**
  only (see `docs/AUTHZ-DOCUMENT-ACCESS.md`). Omit `share` for owner-only. There is
  no separate `visibility` field and no `share.private` key.

### `find`

- Result shape: `{ items: FindItem[], evidence?, degraded? }`.
- `evidence` is omitted unless `includeEvidence: true` (HTTP always sets it).
- Hit field: `documentId` (was `document_id` on internal search hits; plane maps it).
- Limit param: `limit` (1–50), not `k`.

### `recent`

- Same event shape as the old timeline; param is `limit` (1–100).

## HTTP routes

| Was | Now |
| --- | --- |
| `POST /api/knowledge/capture` | `POST /api/memory/add` |
| `POST /api/knowledge/search` | `POST /api/memory/search` |
| `GET /api/knowledge/timeline` | `GET /api/memory/list` |
| `POST /api/memory/find` | `POST /api/memory/search` |
| `GET /api/memory/recent` | `GET /api/memory/list` |
| `POST /api/memory/ask` | **removed** (host-owned inference) |

Old paths return **404**. No redirect, no dual mount.

### Wire body / response deltas

- **add** request: `{ title, text, access_tags?, share? }`. Response: `{ documentId }` (dropped `status: "captured"`).
- **search** request: `{ query, limit? }` (`k` is no longer accepted). Response: `{ items, evidence?, degraded? }` (was `{ hits, evidence, degraded? }`).
- **list** response: `{ events: [...] }` (same shape as old `recent`).
- **ask** / **remember** / **recall**: not product surface — host calls its model, then `add` / `search`.

## Grants

| Was | Now |
| --- | --- |
| `requireGrant("knowledge", "capture")` | `requireGrant("memory", "add")` |
| `requireGrant("knowledge", "search")` | `requireGrant("memory", "search")` |
| `requireGrant("memory", "find")` | `requireGrant("memory", "search")` |

`search` and `list` both require the **`search`** action on resource
`memory`. Old resource/action names are not accepted — update grant rows in the
host grant store before deploy.

## Package / public API rename (`@corbits/memory`)

| Was | Now |
| --- | --- |
| `@corbits/knowledge-engine` | `@corbits/memory` |
| `mountKnowledgeEngine` | `createMemory({ app, … })` |
| `mountKnowledgeRoutes` | `registerMemoryRoutes` (or `createMemory({ app })`) |
| `mountMemory` / `mountMemoryRoutes` | `createMemory({ app })` / `registerMemoryRoutes` |
| `createKnowledgePlane` | `createMemory` |
| `loadKnowledgeConfig` | `loadMemoryConfig` |
| `runKnowledgeMigrations` | `runMemoryMigrations` |
| `KnowledgePlane` / `KnowledgeConfig` / `KnowledgeError` | `Memory` / `MemoryConfig` / `MemoryError` |
| plane verbs `find` / `recent` / `ask` | `search` / `list` / *(removed)* |
| `options.memory` / `options.memoryProvider` | **removed** (no MemoryProvider product path) |
| Access tags `knowledge.owner:` / `knowledge.tenant:` / `knowledge.space:` | `memory.owner:` / `memory.tenant:` / `memory.space:` |

Postgres schema name remains **`knowledge`** (tables such as `knowledge.document`).

## Host checklist (this package's consumers)

1. Rename plane method calls and identity fields; switch package import to `@corbits/memory`.
2. Point HTTP clients at `/api/memory/add|search|list` (not find/ask/recent).
3. Rewrite grant rules: resource `knowledge`→`memory`, `capture`→`add`, `find`/`search`→`search`.
4. Drop any reliance on `status: "captured"` or `hits` / `k` on the wire.
5. If you use file capture, pass `textExtractor` into `createMemory` / mount options.
6. Document access is grant tags (`accessTags` + creator + host `GrantStore`), not
   visibility modes or block lists. Update any host code that wrote `visibility`.
7. Drop `ask` / `remember` / `recall` / `generate` / `memoryProvider` usage — host owns inference.
7. Fresh Postgres: baseline migrations are `0001_extensions.sql` +
   `0002_knowledge_baseline.sql` (schema `knowledge`, `access_tags` on document).
   Existing DBs: drop/recreate the knowledge schema (no in-place dual-write migration).
