# Migration guide — green API cutover (0.2.0)

Hard cutover. There is no dual-path or alias period. Hosts and grant tables must
move to the new names in the same release.

## Plane surface

| Was | Now |
| --- | --- |
| `knowledge.capture(params)` | `knowledge.add(params)` |
| `knowledge.search(params)` | `knowledge.find(params)` |
| `knowledge.timeline(params)` | `knowledge.recent(params)` |
| `knowledge.ask(params)` | unchanged verb; grant action changed (below) |

Identity fields on every call:

| Was | Now |
| --- | --- |
| `subjectId` | `principalId` |
| `scopeId` | `tenantId` |

### `add`

- Returns `{ documentId }` only (no `status` / `versionId` / `chunks` on the public result).
- Exactly one of `content: { title, text }` or `file: { bytes, mimeType?, filename? }`.
- File ingest requires a host-supplied `textExtractor` on the plane options.
- Optional `share` sugar (`private` / `tenant` / `principals`) maps to **access tags**
  only (see `docs/AUTHZ-DOCUMENT-ACCESS.md`). There is no separate `visibility` field.

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
| `POST /api/knowledge/capture` | `POST /api/knowledge/add` |
| `POST /api/knowledge/search` | `POST /api/knowledge/find` |
| `GET /api/knowledge/timeline` | `GET /api/knowledge/recent` |
| — | `POST /api/knowledge/ask` (new) |

Old paths return **404**. No redirect, no dual mount.

### Wire body / response deltas

- **add** request: `{ title, text, access_tags?, share? }`. Response: `{ documentId }` (dropped `status: "captured"`).
- **find** request: `{ query, limit? }` (`k` is no longer accepted). Response: `{ items, evidence?, degraded? }` (was `{ hits, evidence, degraded? }`).
- **recent** response: unchanged `{ events: [...] }`.
- **ask** request: `{ query, limit? }`. Response: `{ text, citations, evidence }`.

## Grants

| Was | Now |
| --- | --- |
| `requireGrant("knowledge", "capture")` | `requireGrant("knowledge", "add")` |
| `requireGrant("knowledge", "search")` | `requireGrant("knowledge", "find")` |

`find`, `ask`, and `recent` all require the **`find`** action. Old action names
are not accepted — update grant rows in the host grant store before deploy.

In-process `ask()` also checks `knowledge` / `find` (was `search`).

## Host checklist (this package's consumers)

1. Rename plane method calls and identity fields.
2. Point HTTP clients at the new paths and bodies.
3. Rewrite grant rules: `capture`→`add`, `search`→`find`.
4. Drop any reliance on `status: "captured"` or `hits` / `k` on the wire.
5. If you use file capture, pass `textExtractor` into `createKnowledgePlane` / mount options.
6. Document access is grant tags (`accessTags` + creator + host `GrantStore`), not
   visibility modes or block lists. Update any host code that wrote `visibility`.
7. Fresh Postgres: baseline migrations are `0001_extensions.sql` +
   `0002_knowledge_baseline.sql` (schema `knowledge`, `access_tags` on document).
   Existing DBs: drop/recreate the knowledge schema (no in-place dual-write migration).
