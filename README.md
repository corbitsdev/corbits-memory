# @corbits/knowledge-engine

A knowledge capture + search engine you **mount** onto an [Interchange](https://github.com/corbitsdev) hub.

`mountKnowledgeEngine(app, opts)` adds hybrid semantic + keyword search, capture
(with per-document ACLs), and a grant-checked in-process `ask()` to your
Interchange `createApp`.

MCP is a separate concern: mount `@corbitsdev/hono-openapi-mcp` to expose these
(or any documented) routes as MCP tools — no MCP code lives in this package.

**It authenticates nothing.** Identity is the request principal, read straight
off the Interchange context (`c.get("principal")`); authorization goes through
the host's own grant store (`@intx/authz`). No API keys, no sessions, no OAuth
live here — Interchange already did all of that before the request reaches a
mounted route.

**The engine never embeds in-process.** Every capture and search call goes out
to an embedding endpoint you configure — any OpenAI-compatible, TEI, or
Ollama-style API.

Requires Bun 1.2+.

## What you get

- **Capture / search / timeline** HTTP routes, each guarded with
  `requireGrant("knowledge", <action>)`. Timeline titles use the same document
  ACL as search (visibility modes + fail-closed block lists).
- **Grant-checked `ask()`** on the plane: retrieves as the principal, grounds a
  host-supplied `generate` callback, returns citations. Safe to call outside
  HTTP because the capability check lives inside the method.
- **Out-of-band plane** via `createKnowledgePlane` for CLI seeders, batch
  ingesters, and tests — no Hono app required.
- **Configurable lexical language** (`FTS_LANGUAGE`, default `english`) baked
  into the generated tsvector at migration time and verified at query time.
- **Multi-model embeddings** with per-model tables; models above 2000 dims use
  halfvec expression indexes (up to 4000) so dense search can still hit an index.
- **Optional cross-encoder rerank** (TEI, Cohere v2, or Voyage). Retrieval
  degrades to fusion-only when unset. Hosts can poll degrade-metrics snapshots
  to surface silent degradation without the engine owning a `/metrics` port.

## Install

```bash
bun add @corbits/knowledge-engine
```

## Mount it

```ts
import { mountKnowledgeEngine } from "@corbits/knowledge-engine";
import { loadKnowledgeConfig } from "@corbits/knowledge-engine/config";

// `app` is your Interchange createApp (Hono<TenantEnv>). Pass the same grant
// store + condition registry you give createApp/createRequireGrant.
mountKnowledgeEngine(app, {
  config: loadKnowledgeConfig(),          // or build the object yourself
  grants: { grantStore, conditionRegistry },
});
```

That mounts `POST /api/knowledge/add`, `POST /api/knowledge/find`,
`POST /api/knowledge/ask`, and `GET /api/knowledge/recent`, each guarded with
`requireGrant("knowledge", <action>)` (`add` or `find`). Clients never send
tenant or principal — identity is the context principal.

### The host must resolve tenant + principal for `/api/knowledge/*`

These routes read `c.get("principal")`, but they mount at `/api/knowledge/*` —
**outside** `/api/tenants/:tenantId/*`, which is where Interchange's own
`createResolveTenant` middleware is scoped and where it reads the tenant from
the path param. Nothing populates the context for our prefix, so the host has to:

```ts
// Mount BEFORE mountKnowledgeEngine — the grant guard runs first and needs a
// principal on the context.
app.use("/api/knowledge/*", async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthorized" }, 401);

  // Your choice how the tenant is selected — a header, a subdomain, or the
  // user's only membership. There is no path param to read.
  const tenantRow = await resolveTenantSomehow(c);
  const principalRow = await db.query.principal.findFirst({
    where: and(
      eq(principal.tenantId, tenantRow.id),
      eq(principal.kind, "user"),
      eq(principal.refId, user.id),
    ),
  });
  if (!principalRow) return c.json({ error: "not a member" }, 403);
  if (principalRow.status !== "active")
    return c.json({ error: "inactive" }, 403);

  c.set("tenant", tenantRow);
  c.set("principal", principalRow);
  await next();
});
```

Without it every knowledge route returns **401 `principal_required`**.

### Capturing and searching outside a request

`mountKnowledgeEngine` returns the `KnowledgePlane` it built, and the plane takes
identity as data — so an in-process caller passes `{tenantId, principalId}`
explicitly rather than faking a request context:

```ts
const { knowledge } = mountKnowledgeEngine(app, { config, grants });

await knowledge.search({ tenantId, principalId, query: "…", k: 6 });
```

For a CLI seeder, a batch ingester, or a test with no app at all, construct a
plane directly:

```ts
import {
  createKnowledgePlane,
  loadKnowledgeConfig,
} from "@corbits/knowledge-engine";

const knowledge = createKnowledgePlane(loadKnowledgeConfig());
await knowledge.capture({ tenantId, principalId, title, text });
await knowledge.close();
```

`capture()` and `search()` do **not** check the capability grant. They apply
per-document visibility and block lists, which is not the same question. So if
the caller is acting on behalf of a user rather than as an operator, check it
yourself:

```ts
import { authorize } from "@intx/authz";

const decision = await authorize(
  grantStore,
  principalId,
  tenantId,
  "knowledge",
  "search",
  conditionRegistry,
);
if (decision.effect !== "allow") throw new Error("not permitted");
```

Apply the knowledge/vector schema once (idempotent):

```ts
import { runKnowledgeMigrations } from "@corbits/knowledge-engine/migrations";
// Reads FTS_LANGUAGE from the environment (default "english") and fails
// loudly if the database was migrated under a different language.
await runKnowledgeMigrations(process.env.KNOWLEDGE_DATABASE_URL);
```

## ask()

`knowledge.ask()` answers a question from retrieved context, in-process — no
HTTP hop, no separate host-side answer synthesis. It is grant-checked
internally, so it is safe to call from anywhere a host has resolved a
principal, even code paths that never go through the mounted HTTP routes:

```ts
const { text, citations, evidence } = await knowledge.ask({
  tenantId,
  principalId,
  query,
  k: 6, // optional, defaults to hybridSearch's default
});
```

1. Checks the capability grant (`authorize(grantStore, principalId, tenantId,
"knowledge", "search", conditionRegistry)`) and throws
   `KnowledgeNotPermittedError` unless the effect is an explicit `"allow"` — no
   matching grant (`effect: null`) denies too. This runs whether or not the
   call came through the HTTP route guard, so it can never be forgotten.
2. Searches as that principal (`hybridSearch`), so per-document visibility and
   block lists apply exactly as they do for `search()`.
3. Assembles a grounded context block from the hits' `snippet` text (search
   truncates each snippet to ≤240 chars today — that is the MVP grounding
   limit), then truncates the assembled block to a character budget. Citation
   numbers are sequential among entries actually included in the prompt.
4. Calls the **host-supplied** `generate` function with a system prompt that
   instructs answering only from context and refusing explicitly when the
   context doesn't contain the answer.
5. Returns the answer text, the citations included in the prompt (matched to
   the `[N]` markers the model was asked to use), and the search's evidence
   level.

### The engine owns no generation client

`ask()` takes generation as an injected function, not as config:

```ts
type Generate = (messages: readonly ChatMessage[]) => Promise<string>;

mountKnowledgeEngine(app, {
  config,
  grants,
  generate: async (messages) => runInferenceSomehow(messages),
});
```

This is deliberate. Interchange already has an inference layer
(`@intx/inference`) with provider adapters, tenant-scoped credentials, a retry
policy, audit collection and authz gates. A `fetch` client here would bypass all
of it and take an API key from a raw env var — so hosts wire `generate` to that
layer instead, and credentials stay in the credential store where they belong.

It also keeps the engine transport-free, which is the posture it already takes
on embedding: never in-process, always an endpoint the owner plugs in.

Omit `generate` if the host only captures and searches; `ask()` then fails with
a 501 naming what is missing rather than at some later point.

Two things that belong in the host's `generate`, learned the hard way:

- **Timeouts must be generous for local models.** A cold 10GB model can take
  over a minute to page into memory before emitting a token.
- **Use a non-reasoning model.** A reasoning model that exhausts its budget
  returns chain-of-thought with empty content, and the host will see an empty
  answer. Detect it there and say so.

## Local development

The SDK is not a server — it mounts onto your app. This repo ships a
`compose.yml` for the backing services so you can develop against it:

```bash
docker compose up -d                                   # pgvector + Ollama + reranker
docker compose exec ollama ollama pull nomic-embed-text
cp .env.example .env
bun install
bun run db:setup                                       # apply the knowledge schema
```

## Config

`loadKnowledgeConfig()` reads the environment (see `.env.example`) and returns a
`KnowledgeConfig` — just the vector DB and model endpoints. Hosts that don't
want env-driven config can build the object directly. See `PRODUCT.md` for the
shape and the identity/ACL model, and `IMPLEMENTATION.md` for env vars and
service internals.

### Reranking

Reranking is optional (`RERANK_BASE_URL` etc.). Supported API styles are **TEI,
Cohere v2, and Voyage**; retrieval degrades to fusion-only when no base URL is
set.

Document character budgets (`RERANK_MAX_DOC_CHARS`) and startup validation
against known model token limits apply to the **TEI path only** — TEI rejects
the whole batch if any single document exceeds the cross-encoder's limit, and
the engine's ~700-token chunks routinely exceed `bge-reranker-base`'s 512.
Left unset, the budget is derived from the resolved model's advertised token
limit rather than a single constant (the engine default, `bge-reranker-v2-m3`,
has an 8,192-token limit — over 16× `bge-reranker-base` — so a one-size budget
would either 413 the smaller model or over-truncate the larger one).

The TEI budget also reserves space for the query (the limit is on the
query+document pair). If the query alone leaves less than a useful minimum for
the document, reranking is skipped for that request (logged, reported as
`"rerank_query_too_long"`) rather than truncating the query.

`mountKnowledgeEngine` validates the TEI budget against known models at startup
and throws `RerankConfigError` on a mismatch. A replay's `transform_config` can
supply its own rerank endpoint/model; that path is validated the same way at
request time and degrades to fused ranking on a mismatch instead of throwing.

Truncation is a real tradeoff: the reranker scores only the head of a chunk
while callers still cite the whole thing, and the char budget is an estimate
(~3 chars/token for prose — denser content like CJK, minified code, or base64
can still overflow). Lower `RERANK_MAX_DOC_CHARS` for those corpora.

### Degrade metrics

When retrieval degrades (missing embed model, rerank failure, query-too-long,
and similar), the engine records counters you can poll — there is no metrics
port in this package. Export `getDegradeMetricsSnapshot` /
`getAllDegradeMetricsSnapshots` (and optional `configureDegradeMetrics`) and
forward them from the host's own metrics backend.

## Testing

```bash
bun run test            # unit suite: bun test ./src
bun run test:coverage
bun run typecheck
```

Unit tests are colocated under `src/` and run entirely against mocked
boundaries — no external services required.

## License

LGPL-2.1 — see [`LICENSE`](LICENSE).
