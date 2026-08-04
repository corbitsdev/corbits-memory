# @corbits/knowledge-adapter-supermemory

**Replaceable DocumentStore** for [@corbits/knowledge-engine](https://github.com/corbitsdev/corbits-knowledge-engine)
backed by the [Supermemory](https://supermemory.ai/) HTTP API.

Pure `fetch` — **no** vendor SDK. Tenancy is enforced with a length-prefixed
`containerTag` so free-form ids cannot collide.

## Product path: DocumentStore

Supermemory is a **full backend replacement** for local pgvector — not a
side-channel memory bolt-on. Mount it as `documentStore`; the plane routes
`add` / `find` / `recent` (and `ask` via find) through the store. No Postgres /
embed endpoints required.

```ts
import { createKnowledgePlane } from "@corbits/knowledge-engine";
import { createSupermemoryDocumentStore } from "@corbits/knowledge-adapter-supermemory";

const knowledge = createKnowledgePlane(undefined, grants, {
  documentStore: createSupermemoryDocumentStore({
    apiKey: process.env.SUPERMEMORY_API_KEY!,
  }),
  generate: myGenerate,
});
```

Or via mount:

```ts
mountKnowledgeEngine(app, {
  documentStore: createSupermemoryDocumentStore({ apiKey }),
  grants,
  generate,
});
```

Find uses `searchMode: "hybrid"` so document retrieval works for the green
plane (add/find/ask), not memories-only personal facts.

## What is out of scope

- **Not** a tools-shaped source (Linear-style live connectors stay separate).
- **Not** the product path for `MemoryProvider` / `includeMemory`.
- `createSupermemoryMemoryProvider` remains exported for back-compat only
  (memories-only recall); prefer `createSupermemoryDocumentStore`.

## Tenant mapping

```ts
import { containerTag } from "@corbits/knowledge-adapter-supermemory";

containerTag("acme", "alice"); // "t4_acme_u5_alice"
```

Never pass bare `principalId` as `containerTag`.

## HTTP surface (thin)

| Verb   | Method | Path              | Notes                          |
| ------ | ------ | ----------------- | ------------------------------ |
| add    | POST   | `/v3/documents`   | content + containerTag         |
| find   | POST   | `/v4/search`      | `searchMode: "hybrid"`         |
| recent | —      | empty             | API has no recent feed here    |

Auth: `Authorization: Bearer <apiKey>`.

## License

LGPL-2.1-only (same as the knowledge engine).
