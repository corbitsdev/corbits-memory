# Knowledge Engine — Implementation Reference

This is the detailed implementation reference: concrete files, tables, functions,
and wire shapes. For the "why standalone" / boundaries story, read
`ARCHITECTURE.md` first — this doc complements it, it does not repeat it.

## Repo layout

```
src/
  index.ts                # mountKnowledgeEngine / mountKnowledgeRoutes
  mount-config.ts         # KnowledgeConfig + loadKnowledgeConfig() — the mount config
  config.ts               # EngineConfig — the core vector-plane config (db + embed + rerank)
  knowledge.ts            # createKnowledgePlane — capture/search against pgvector
  acl.ts                  # parseAcl — document ACL (scope/tenant/private/allowlist)
  capture-log.ts          # in-memory recent-capture ring buffer (timeline)
  log.ts                  # getLogger(["knowledge-engine"]) from @intx/log
  migrations.ts           # runKnowledgeMigrations(url)
  routes/                 # the mounted routes
    mount.ts              # mountKnowledgeRoutes (HTTP)
    deps.ts               # RouteDeps, caller(c) (context identity), grantGuard, readJsonBody
    capture.ts, search.ts, timeline.ts
  db/
    schema.ts             # Drizzle table defs for every fixed-shape table
    client.ts             # createDb(config) -> { db (drizzle), sql (raw postgres-js) }
  services/
    capture.ts            # captureDocument, deriveFromRawCapture — the write path
    search.ts             # hybridSearch and every retrieval-candidate query
    transform.ts          # transform_config CRUD + runTransform (replay)
  core/                   # framework-agnostic, mostly pure (chunking, embed/rerank
                          # clients, authority, hybrid fusion, MMR, schemas)
migrations/               # pgvector schema, applied in filename order by scripts/db-setup.ts
scripts/db-setup.ts       # idempotent migration runner, tracked in `_migrations`
compose.yml               # pgvector + Ollama + reranker for local dev
```

The SDK has no server and no process entrypoint. `mountKnowledgeEngine` takes
the host's `Hono<TenantEnv>` app plus `{ config, grants? }` and mounts the
routes; each reads identity from the context (`caller(c)`) and guards via
`grantGuard`. Services take `{ db, sql, config }` explicitly (no module-level
singletons except the logger). Nothing has import-time side effects, so unit
tests exercise the routes and services directly without a listening server.

## Config

There are two config types, both in the SDK:

- **`EngineConfig`** (`src/config.ts`) — the core vector-plane config the DB
  client and capture/search/transform services consume: `databaseUrl`,
  `dbPoolMax`, `embed`, `rerank`.
- **`KnowledgeConfig`** (`src/mount-config.ts`) — what `mountKnowledgeEngine`
  takes: just `{ knowledge: EngineConfig }`. `loadKnowledgeConfig()` builds one
  from the environment; hosts may also construct it programmatically. Auth,
  tenancy, and grants are the host's — none of that is config here.

`loadKnowledgeConfig()` uses the same fail-loud helpers: `requireEnv(name)`
throws if unset/empty, `optionalEnv(name)` returns `undefined`, `intEnv(name,
fallback)` parses a positive integer or throws.

| Var | Required? | Default | Notes |
|---|---|---|---|
|  `KNOWLEDGE_DATABASE_URL` | **yes** | — | the engine's own pgvector Postgres |
| `DB_POOL_MAX` | no | `8` | postgres-js pool size |
| `FTS_LANGUAGE` | no | `english` | text search config for the lexical channel; fixed into the generated column at migration time — changing it later requires rebuilding the column, and `runKnowledgeMigrations` fails loudly if config and column disagree |
| `EMBED_BASE_URL` | **yes** | — | embed endpoint root, no path suffix |
| `EMBED_MODEL` | **yes** | — | model id/name passed to the embed endpoint |
| `EMBED_API_STYLE` | no | `"openai"` | `"openai" \| "tei" \| "ollama"` |
| `EMBED_API_KEY` | no | `undefined` | forwarded as `Authorization: Bearer <key>` |
| `RERANK_BASE_URL` | no | `undefined` | absent => search degrades to fusion-only |
| `RERANK_MODEL` | no | `undefined` | defaults to `bge-reranker-v2-m3` in the client |
| `RERANK_API_KEY` | no | `undefined` | forwarded as Bearer token to the rerank endpoint |

The engine's `EngineConfig.rerank` carries
no `apiStyle` field of its own; `search.ts`'s `toRerankClientConfig` hardcodes
`apiStyle: "tei"` when building the client config, i.e. the engine currently
only wires a TEI-compatible reranker via env (Cohere/Voyage rerank backends
are reachable only through a per-`transform_config` `rerank.apiStyle`, not
through top-level env).

**Model endpoints are trusted URLs — no SSRF guard, no self-host flag.** Every
embed/rerank endpoint the engine calls — its own `EngineConfig.embed`/
`EngineConfig.rerank` (the capture embed pass, the dense-search query embed,
the embed-model-registry probe/activation, and `toRerankClientConfig`) and a
`transform_config`'s replay embed override (`buildEmbedClientConfig` in
`services/transform.ts`) — is treated as a trusted URL, exactly like
`KNOWLEDGE_DATABASE_URL`. There is no private-IP / SSRF filtering and no `allowSelfHost`
knob anywhere: a self-hosted endpoint on `localhost` or a private IP is just a
URL, indistinguishable from a managed provider. Model/replay endpoints are
configured by the operator (env) or named by a trusted caller in a
`transform_config`, never by an unauthenticated request — so operators who need
egress control front the endpoints with an allowlisting proxy.

## Data model (`src/db/schema.ts` + `migrations/*.sql`)

All tables are Drizzle-defined in `db/schema.ts`, DDL'd in `migrations/`
(applied by `scripts/db-setup.ts`, tracked in a `_migrations` ledger table so
re-running is a no-op). No knowledge table has a foreign key into any
control-plane table — `tenant_id`/`principal_id`/source refs are plain `text`.

### `knowledge_document`
The stable logical row for a captured source. Unique on
`(tenant_id, adapter, external_ref)` — this triple is the dedupe/identity key
every capture upserts against. Visibility/ACL lives directly on the row:
`visibility_mode` (`'tenant'|'principals'|'source_acl'|'private'`),
`visibility_principal_ids` (jsonb array), `visibility_source_acl` (jsonb
array). `attributes` is a flat jsonb bag of scalars. `last_seen_at` bumps on
every re-capture, even a content-hash NOOP.

### `knowledge_version`
The versioned body of a document. `version` is a monotonic integer scoped to
`(document_id, generation)` — **not** globally per-document — per the
`knowledge_version_document_generation_version_uniq` unique index (migration
0009). `status` tracks `'active'|'superseded'|'deprecated'|'archived'|'tombstoned'`;
only one `active` row exists per `(document_id, generation)` at a time (the
capture path enforces this by flipping the prior active row to `superseded`
before inserting a new one). `content_hash` is the NOOP-check key. Attribution
columns: `created_by_principal_id`, `created_by_kind`
(`'human'|'agent'|'system'|'adapter'`), `generator_agent_id`. Authority
columns (`authority`, `actor_count`, `has_social_signal`, `source_class`) are
a **snapshot computed once at capture time** (`computeAuthority`, never
recomputed retroactively). `raw_capture_id` points at the immutable source row
this version was derived from. `generation` (added by migration 0009,
default `'live'`) is the replay-generation tag: the normal `/capture` path always writes
`'live'`; a replay (`runTransform`) writes its own `transform_run.id` instead,
so a replayed corpus's versions never collide with, or even become visible
alongside, the live ones unless a caller explicitly searches that generation.

### `knowledge_chunk`
An ordered slice of a version's text, keyed by `(version_id, ordinal)`
(unique). Carries a generated-always `text_fts tsvector` column (GIN-indexed)
that powers the lexical search channel — this is the only place FTS is
computed; no separate FTS table exists. Its language comes from
`FTS_LANGUAGE` at migration time; the query side binds the same configured
language as a `regconfig` parameter, and `runKnowledgeMigrations` verifies
the column's actual language against the configuration (read back from the
catalog) so a mismatch fails at startup instead of silently degrading
recall. Chunks are **never** reused across
versions — every new version gets a fresh full insert of its own chunks.

### `knowledge_entity` / `knowledge_edge`
Lightweight graph rows. `knowledge_entity` has no unique constraint; dedupe on
`(tenant_id, kind, identifiers)` is done in application code
(`upsertEntity` in `capture.ts`, an exact-match linear scan per kind). Same for
`knowledge_edge` (dedupe on the full `(tenant_id, rel, from, to)` tuple,
`upsertEdge`). `rel` is constrained (DB CHECK + arktype) to
`'about'|'produced_by'|'links'|'parent'|'mentions'|'waiting_on'`; `from_type`/
`to_type` to `'document'|'entity'|'native'`.

### `knowledge_embed_model`
Per-tenant registry of which embed model is currently active, and the
dimensionality it was discovered at (`discoverModelDims`/`probeEmbedDims` —
dims are **never** hard-coded, always probed live against the endpoint).
Unique on `(tenant_id, model_key)`, where `model_key` is
`sha256(baseUrl|modelId).slice(0,16)` (`computeModelKey`). "Active" means the
most-recently-`updated_at` row with `status = 'active'` for that tenant
(`resolveActiveEmbedTable`) — there is no per-generation embed-model scoping
(see "Known limitation" under Raw + replay below).

### Dynamic per-model vector tables: `knowledge_embedding_<key>`
Not in `db/schema.ts` (no fixed shape — dimensionality varies by model) and
not in any migration file. Created at runtime by
`activateEmbedModel` (`embed-model-registry.ts`) the first time a given
`(baseUrl, modelId)` pair is used:
```sql
CREATE TABLE IF NOT EXISTS knowledge_embedding_<key> (
  chunk_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  embedding vector(<dims>),
  CONSTRAINT knowledge_embedding_<key>_chunk_fk
    FOREIGN KEY (chunk_id) REFERENCES knowledge_chunk (id) ON DELETE CASCADE
)
```
plus a `(tenant_id, chunk_id)` index (created on every activation, so it
retrofits onto older tables). The FK completes the hard-delete cascade
chain document -> version -> chunk -> embedding. `CREATE TABLE IF NOT
EXISTS` cannot add the FK to a table created before it existed; that gap is
accepted (no populated pre-FK installs exist). If hard deletes are ever
introduced against such a table, run once, per embedding table:
```sql
ALTER TABLE knowledge_embedding_<key>
  ADD CONSTRAINT knowledge_embedding_<key>_chunk_fk
  FOREIGN KEY (chunk_id) REFERENCES knowledge_chunk (id) ON DELETE CASCADE;
```
plus an HNSW index: `vector_cosine_ops` up to 2000 dims (falling back to
`ivfflat` if the Postgres/pgvector build lacks the `hnsw` access method), or
a `halfvec` expression index (`halfvec_cosine_ops`, pgvector >= 0.7) for
2001–4000 dims — pgvector's `vector`-typed indexes cap at 2000 dims. Models
above 4000 dims are rejected at activation (`MAX_EMBED_DIMS`) since no index
type could serve them. `MAX_EMBED_DIMS` is now pinned to
`HALFVEC_INDEX_MAX_DIMS` (4000, pgvector's halfvec index cap), narrowed down
from the previous 4096 — a model in the 4001–4096 range that used to
activate and only fail later (no index type covering it) now fails loudly
at activation instead. The dense query's `ORDER BY` is generated by
`cosineDistanceExpr` from the same module so it always matches the indexed
expression. The table name is
validated against `EMBED_TABLE_NAME_PATTERN`
(`/^knowledge_embedding_[a-f0-9]{16}$/`) both when computed and again every
time it's read back from `knowledge_embed_model`, before ever being
string-interpolated into raw SQL — this is the only place in the codebase a
computed identifier is spliced into DDL/DML.

### `raw_capture`
The immutable, append-only substrate (the raw-capture layer). Stores the exact `/capture`
request payload (`adapter`, `occurred_at`, `document`) as JSON in `raw_text`
(there's also a `raw_bytes bytea` column for non-textual payloads, currently
unused by any write path — everything captured today is JSON). Deduped on
`(tenant_id, source_hash)`, where `source_hash` is
`sha256(stableStringify({adapter, occurredAt, document}))` — a byte-identical
recapture reuses the existing row (`insertOrReuseRawCapture`) rather than
inserting a duplicate; the table never has rows updated or deleted by
ingestion.

### `transform_config`
A named, versioned recipe of derivation + retrieval-tuning knobs
(`TransformConfigParams`: `chunk` — only `token.recursive` is a valid
strategy today — `embed`, optional `rerank`, `authorityWeight`,
`recencyHalfLifeDays`, `mmrLambda`, `overfetch`). Unique on
`(tenant_id, name, version)`; re-`POST`ing the same `name` mints
`version = max(existing) + 1` rather than colliding (`createTransformConfig`).

### `transform_run`
One execution of a `transform_config` against a (possibly scoped) slice of
`raw_capture`. `generation` is this run's own id, unique
(`transform_run_generation_uniq`) — so a generation always resolves back to
exactly one run and therefore one config at search time
(`resolveGenerationSearchParams`). `status` is `'running'|'completed'|'failed'`;
`scope` is jsonb (`{ adapter?, since?, until? }`, filtering on
`raw_capture.fetched_at`). `runTransform` never throws for a mid-run
derivation failure — it marks the run row `'failed'` with `error` recorded and
returns the run summary either way.

## Capture flow (`services/capture.ts` — `captureDocument`)

1. **`adaptAndPlan(document)`** (`core/adapt-and-plan.ts`, pure, no I/O):
   validates `title`/`kind` are non-empty, re-chunks every incoming
   `AdaptedDocumentChunk` through the chunker port (default
   `chunkTokenRecursive`, caps `DEFAULT_CHUNK_CAPS` = 700 max / 40 min / 60
   overlap tokens — `adaptAndPlan`'s internal `rechunk` always applies these
   defaults regardless of chunker, which is why the live path is unaffected
   by a replay's custom caps), and computes `contentHash` over
   `title + kind + externalRef + stableStringify(attributes) + joined chunk
   text` (`core/hash.ts`) — this hash is the NOOP-check key.
2. **`insertOrReuseRawCapture`**: hashes the raw wire payload
   (`computeSourceHash`, independent of `contentHash` — this one covers the
   *unadapted* input including `adapter`/`occurredAt`) and looks it up by
   `(tenantId, sourceHash)`; reuses the existing `raw_capture` row or inserts
   a new one, all inside the same transaction as the derived rows.
3. **`deriveVersionInTransaction`** — the single derivation core shared by
   live capture and replay:
   - No existing `knowledge_document` for `(tenantId, adapter, externalRef)`
     → insert a new document row + a version at `version = 1`,
     `supersedesVersionId = null`.
   - Existing document, and its current `active` version (scoped to this
     `generation`) has the **same** `contentHash` → **NOOP**: bump
     `last_seen_at` only, write nothing else, return
     `{ status: "noop", chunks: 0 }`.
   - Existing document, content changed → flip the prior active version to
     `status: "superseded"`, insert a new version at `version + 1` with
     `supersedesVersionId` pointing at it, update the document's mutable
     fields (`title`, `visibility*`, `attributes`, `last_seen_at`).
4. **`insertChunksAndGraph`**: inserts every plan chunk fresh (chunks are
   never reused across versions), then best-effort upserts entity hints
   (`upsertEntity`) and edge hints (`upsertEdge`) — these are independent of
   version and never rolled back if a later step fails within the same
   transaction (they're just additional statements inside it).
5. **After the transaction commits** — `embedInsertedChunksWithConfig`:
   resolves/activates the tenant's embed model (`activateEmbedModel`, probing
   dims live and creating the per-model vector table if needed), then
   `embedChunks` embeds and inserts vectors for the freshly-inserted chunks.
   This step is **best-effort**: an embed-client failure (timeout, HTTP
   error) or a per-chunk dims mismatch is logged via
   `log.warn` and never thrown — the chunk rows are already durable in
   Postgres, and the module's own comments note a later re-embed pass could
   pick up anything left unembedded (no such background pass exists yet in
   this repo; chunks left unembedded simply never populate the dense
   channel for the query — they're still found by lexical/FTS). Any of these
   failure modes sets `degraded: true` on the `CaptureResult`, surfaced by
   `POST /api/knowledge/capture` as a `degraded` field in its response — the capture
   still succeeded (chunks are durable and lexically searchable), only the
   dense/vector channel for those chunks is incomplete.

**Request-size guards independent of embedding.** `index.ts` caps the whole
request body at `MAX_REQUEST_BODY_BYTES = 10 MB` (`hono/body-limit`,
rejecting oversized bodies with `413` before they're even parsed as JSON);
`core/schemas/adapted-document.ts` separately caps a single chunk's text at
`MAX_CHUNK_TEXT_CHARS = 100,000` chars, the number of chunks per document at
`MAX_CHUNKS_PER_DOCUMENT = 2,000`, `title` at `MAX_TITLE_CHARS = 500`, and
`kind` at `MAX_KIND_CHARS = 200` — a payload well under the body-size limit
could otherwise still carry pathologically many or large chunks.

The live path (`captureInTransaction` → `deriveVersionInTransaction`) always
writes `generation = LIVE_GENERATION` (`"live"`, `core/generation.ts`) and
always resolves/reuses its own `raw_capture` row. `deriveFromRawCapture` is
the same core function called directly by a replay with an **existing**
`raw_capture_id` and the run's own generation — a replay never writes a new
`raw_capture` row (the raw-capture corpus is read-only from that path).

## Search pipeline (`services/search.ts` — `hybridSearch`)

Entry point, one query in, one ranked/citable hit list out. `k` is clamped to
`[1, MAX_K=100]`, default `DEFAULT_HYBRID_TOP_K = 8`. An empty `query` string
is only accepted if `kinds` or `entityIds` is provided (structured-filter-only
search); otherwise it throws `KnowledgeSearchInputError` (400).

1. **Generation resolution** — `generation` defaults to `LIVE_GENERATION`.
   For any non-live generation, `resolveGenerationSearchParams` (transform.ts)
   looks up the owning `transform_run` → `transform_config` and pulls its
   tuning knobs (`authorityWeight`, `recencyHalfLifeDays`, `mmrLambda`,
   `overfetch`, `rerank`); every field it doesn't supply falls back to the
   engine's own defaults. Live search never pays for this lookup.
2. **Lexical channel** — `fetchLexicalCandidates`: Postgres full-text search
   (`ts_rank` against `plainto_tsquery('english', query)` over
   `knowledge_chunk.text_fts`), joined to `knowledge_version` (filtered to
   `status = 'active'` and the resolved `generation`) and `knowledge_document`
   (filtered by `visibilityPredicateSql`), optionally further filtered by
   `kinds` and/or `entityIds` (via a sub-select against `knowledge_edge`).
   Overfetches up to `overfetchLimit` rows, non-deduped, per-chunk.
3. **Dense channel** — `fetchDenseCandidates`: embeds the query
   (`embedTexts`), resolves the tenant's single active embedding table
   (`resolveActiveEmbedTable` — **not** generation-scoped, see limitation
   below), runs a raw-SQL cosine-distance ANN query via `cosineDistanceExpr`
   (`e.embedding <=> $vector` up to 2000 dims, or the matching
   `(e.embedding::halfvec(N)) <=> $vector::halfvec(N)` expression above that
   so the halfvec HNSW index is used)
   against that table joined back to
   `knowledge_chunk`/`knowledge_version`/`knowledge_document` with the
   **exact same visibility predicate**, hand-mirrored as
   `VISIBILITY_PREDICATE_RAW_SQL` (there is no third ACL implementation
   anywhere). Returns `null` (not an error) when there's no active embed
   model yet or the query is empty; a thrown error from the embed call or
   the SQL itself is caught by the caller and also folds into `null`/degraded
   — the dense channel never fails the whole search.
4. **RRF fusion** — `fuseRrf` (`core/hybrid-search.ts`): combines the
   lexical and dense per-channel rank orders (never raw scores — they're on
   incomparable scales) via Reciprocal Rank Fusion,
   `score = Σ 1/(60 + rank)`.
5. **Per-document dedupe** (non-reranked path only) —
   `dedupeCandidatesPerDocument`: collapses to the single highest-scoring
   chunk per `documentId`, using `authorityWeightedScore` (`relevance * (1 +
   0.5 * authority)`) as the rank prior, tie-broken by recency.
6. **Rerank** (only if a rerank endpoint is configured — engine env
   `RERANK_BASE_URL`, or the replay generation's `transform_config.params.rerank`):
   dedupe (without the authority prior — authority is applied later on this
   path, never twice), take the top `RERANK_CANDIDATE_LIMIT = 50`, call
   `rerankDocuments` (cross-encoder), sort by rerank score.
7. **Bounded authority/recency boosts** — `applyBoosts`: normalizes the
   active-stage score (rerank score, or fused RRF score on the degraded path)
   to `[0,1]` within the batch, then multiplies by
   `authorityBoostMultiplier` and `recencyBoostMultiplier`, both clamped to
   `[0.7, 1.3]` — a boost can never let a weak match outrank a strong one on
   its own. Take the top `MMR_POOL_SIZE = 20`.
8. **MMR diversity pass** — `mmrRerank` (`core/mmr.ts`): greedy pick
   maximizing `relevance - λ * maxSimilarityToAlreadyPicked` (`λ = 0.7`
   default, or the replay config's `mmrLambda`), using vectors pulled fresh
   from the active embedding table (`fetchChunkVectors`). Items without a
   vector are never dropped — appended by score after every vector-bearing
   item is placed. Produces the final top-`k` order.
9. **Degrade path** — if reranking fails (network error, non-2xx) or was
   never configured, the pipeline falls back to
   `dedupeCandidatesPerDocument(mergedRows, true, authorityWeight).slice(0,
   k)` (fused + authority-weighted order, no MMR) and reports
   `degraded: ["rerank_unavailable"]`. If dense retrieval failed/unconfigured,
   `degraded` includes `"dense_unavailable"` and lexical alone answers.
10. **Finishing** — `attachEntityIds` joins in each surviving document's
    entity edges; `toHit` builds the wire `SearchHit` (citation/open-target
    resolution via `openTarget`, mapping known adapters — `artifact`, `task`,
    `workflow_run`, `mail` — to a deep-linkable `{type, id}`, else a generic
    `{type: "knowledge", id: documentId}`).
11. **Evidence** — `deriveHybridEvidence`: `"none"` if zero hits; `"weak"` if
    the lexical channel contributed zero rows (a dense-only result never
    reports `"strong"`); otherwise `deriveEvidence` on the lexical rows —
    `"strong"` requires **both** the top-ranked hit's raw `ts_rank ≥
    STRONG_RANK_FLOOR (0.05)` **and** its authority `≥
    AUTHORITY_STRONG_FLOOR (0.3)`; else `"weak"`.

Tenant isolation is unconditional and first in every query (`tenant_id`
filtered before any visibility logic); every table/channel is scoped that
way, with no exception.

## Raw + replay (the replay pipeline — `services/transform.ts`)

`raw_capture` is the immutable substrate every replay reads from and never
writes to. A `transform_config` is a named/versioned recipe
(`createTransformConfig`, `listTransformConfigs`) capturing chunk/embed/rerank
+ retrieval-tuning knobs.

`runTransform(configId, scope?)`:
1. Loads the config, mints a new `runId` = the run's own `generation`.
2. Inserts a `transform_run` row (`status: 'running'`).
3. Selects every `raw_capture` row in `scope` (adapter/since/until filters on
   `fetched_at`; an empty scope = a full tenant backfill).
4. For each row: re-parses its stored JSON payload back into a `CaptureInput`
   (`parseRawCapturePayload`, itself validated through
   `RawCapturePayloadSchema` — re-hydrating from storage is treated as its
   own trust boundary, never a blind `JSON.parse`), then calls
   `deriveFromRawCapture` with the config's own chunker
   (`chunkTokenRecursive` with the config's caps) and embed client config,
   targeting the run's `generation` — never the live one.
5. On completion, updates the run row: `status: 'completed'`, `rawCount`,
   `versionCount`. On any exception mid-loop, catches it, logs it, and marks
   the run `'failed'` with `error` set — `runTransform` itself never throws
   to its caller; callers always get a run summary.
6. `resolveGenerationSearchParams` is how `hybridSearch` later maps a
   generation back to its config's search-tuning knobs (authority weight,
   recency half-life, MMR λ, overfetch, rerank config).

**Documented limitation — per-generation embed-model isolation does not
exist.** `resolveActiveEmbedTable` picks the tenant's single
most-recently-`updated_at` active model, with no `generation` argument at
all. If a replay's `transform_config.embed` points at a *different*
`(baseUrl, modelId)` than the live capture path currently uses, running that
replay makes its model the tenant's active dense-channel table for **every**
generation's search, including live's, from that point forward. The `search.ts`
comment on `fetchDenseCandidatesArgs.generation` states this explicitly;
`transform.ts`'s replay test in `e2e.integration.test.ts` sidesteps it by
reusing the exact same embed endpoint/model as the live capture. Scoping
activation per-generation is out of scope for the current replay-pipeline
implementation — callers replaying under a different embed model should do
so knowing it will flip the tenant's live dense channel too.


## Mounted routes

`mountKnowledgeEngine` mounts these onto the host app. Identity is the request
principal read off the Interchange context (`caller(c)` →
`{ scopeId: principal.tenantId, subjectId: principal.id }`); clients never send
`tenant_id`/`principal_id` — the handlers only read title/text/query/k/acl.
Each route is guarded with `grantGuard(deps, action)`, which applies the host's
`requireGrant("knowledge", action)` when provided (else a pass-through).

| Method + path | Grant action | Request body | Response |
|---|---|---|---|
| `POST /api/knowledge/capture` | `capture` | `{ title, text, acl? }` | `200 { status: "captured" }`; `400` on validation |
| `POST /api/knowledge/search` | `search` | `{ query, k? }` (k 1–50) | `200 SearchResponse` (`{ hits[], evidence, degraded? }`); `400` on bad input |
| `GET /api/knowledge/timeline` | `search` | — | `200 { events }` for the caller's scope |

`mountKnowledgeRoutes` and `mountKnowledgeEngine` both mount the three HTTP routes. MCP is a separate package (`@corbitsdev/hono-openapi-mcp`).

The document ACL (`acl` on capture) is validated by `parseAcl` — mode
`scope|tenant|private|allowlist`, `subjects` only (groups/grants rejected until
membership lands). `parseAcl` is the single ACL validator.

## Observability

The SDK does no logging or error-reporting setup of its own — that belongs to
the host app. Routes log a one-line `console.error` on a 5xx-class failure and
return a generic error body; the host's middleware owns request logging and any
Sentry/OTel wiring.

## Local dev

```bash
docker compose up -d                                   # pgvector + Ollama + reranker
docker compose exec ollama ollama pull nomic-embed-text
cp .env.example .env
bun install
bun run db:setup                                       # apply the knowledge schema, idempotent
bun run test                                           # unit suite (no external services)
```

`compose.yml` provisions the pgvector Postgres (`knowledge` db, host port
`5434`), an Ollama embeddings server (`:11434`), and a TEI reranker (`:8085`).
The engine **never embeds internally** — `EMBED_BASE_URL` must point at a real
endpoint. A model endpoint is just a URL + capability options, trusted the same
as `KNOWLEDGE_DATABASE_URL`:

- **Local default**: Ollama at `http://localhost:11434`
  (`EMBED_API_STYLE=ollama`, `EMBED_MODEL=nomic-embed-text`).
- **Paid provider**: e.g. `EMBED_BASE_URL=https://api.openai.com`,
  `EMBED_MODEL=text-embedding-3-small`, `EMBED_API_STYLE=openai`,
  `EMBED_API_KEY=sk-...`.

`RERANK_BASE_URL` is optional — unset runs lexical+dense+MMR without the
cross-encoder (`degraded: ["rerank_unavailable"]`, still ranked/citable hits).

## Testing

`bun test ./src` (`bun run test`), coverage via `bun run test:coverage`. Every
`core/*` module, most services, and the route/identity layer have colocated
`*.test.ts` files exercising pure logic and mocked-boundary behavior — no
external services required. The SDK ships with unit tests only.
