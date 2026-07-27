# @corbits/knowledge-engine

A knowledge capture + search engine you **mount** onto an [Interchange](https://github.com/corbitsdev) hub.

`mountKnowledgeEngine(app, opts)` adds hybrid semantic + keyword search and
capture (with per-document ACLs) to your Interchange `createApp`.

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

## Install

```bash
bun add @corbits/knowledge-engine
```

Until the package is on npm, install from the repository:

```bash
bun add github:corbitsdev/knowledge-engine
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

That mounts `POST /api/knowledge/capture`, `POST /api/knowledge/search`, and
`GET /api/knowledge/timeline`, each guarded with
`requireGrant("knowledge", <action>)`. Clients never send tenant or principal —
identity is the context principal.

Apply the knowledge/vector schema once (idempotent):

```ts
import { runKnowledgeMigrations } from "@corbits/knowledge-engine/migrations";
await runKnowledgeMigrations(process.env.KNOWLEDGE_DATABASE_URL);
```

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
shape and the identity/ACL model.

Reranking (`RERANK_BASE_URL` etc.) is optional and TEI-only today; retrieval
degrades to fusion-only if unset. `RERANK_MAX_DOC_CHARS` (default `1500`)
bounds how much of each chunk's text is sent per document — TEI rejects the
whole batch if any single document exceeds the reranker's token limit, and the
engine's ~700-token chunks routinely exceed `bge-reranker-base`'s 512. The
budget also reserves space for the query: TEI's limit is on the query+document
pair, not the document alone, so a long query shrinks the document's share
before truncation (floored so the document is never cut to nothing).
`mountKnowledgeEngine` validates the default/configured budget against known
models' advertised limits at startup and throws `RerankConfigError` on a
mismatch, rather than failing per query — this is safe to throw on because the
shipped default is chosen to pass validation against `bge-reranker-base`
out of the box.

Truncation is a real tradeoff, in two ways. First, the reranker scores only
the head of a chunk while the caller still cites and reads the whole thing, so
a document whose relevance lives in its tail ranks lower than it deserves.
Second, the char budget is an estimate, not a guarantee: it assumes as few as
~3 characters per token, which holds for ordinary prose but not for CJK text,
minified code, base64, or other dense content that can run closer to ~1
char/token — those corpora can still overflow the reranker's real token limit
even after truncation. Lower `RERANK_MAX_DOC_CHARS` for such corpora.

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
