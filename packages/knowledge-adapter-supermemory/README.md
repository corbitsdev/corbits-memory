# @corbits/knowledge-adapter-supermemory

**Replaceable DocumentStore** for [@corbits/memory](https://github.com/corbitsdev/corbits-memory)
backed by the [Supermemory](https://supermemory.ai/) HTTP API.

Pure `fetch` — **no** vendor SDK. Tenancy is enforced with a length-prefixed
`containerTag` so free-form ids cannot collide.

## Product path: DocumentStore

Mount Supermemory as `documentStore` so the plane routes `add` / `find` /
`recent` (and `ask` via find) through this store — no Postgres / embed
endpoints required. This is the product integration path (not
`MemoryProvider` / `includeMemory`).

```ts
import { createMemory } from "@corbits/memory";
import { createSupermemoryDocumentStore } from "@corbits/knowledge-adapter-supermemory";

const memory = createMemory(undefined, grants, {
  documentStore: createSupermemoryDocumentStore({
    apiKey: process.env.SUPERMEMORY_API_KEY!,
  }),
  generate: myGenerate,
});
```

Or via mount:

```ts
mountMemory(app, {
  documentStore: createSupermemoryDocumentStore({ apiKey }),
  grants,
  generate,
});
```

Find uses `searchMode: "hybrid"` so document retrieval works for the green
plane (add/find/ask), not memories-only personal facts.

## Limitations (honest)

| Area | Behavior |
| --- | --- |
| Isolation | **Principal-bucket only** via `containerTag(tenantId, principalId)`. Each principal has a private container; docs are not shared across principals. |
| Document access | This adapter is **principal-bucket only**. Host grant tags (`accessTags`) are stored as metadata at best and are **not** evaluated. For multi-principal grant-tag ACL, use the default pgvector store. |
| `recent` | Always `[]` — no recent-feed API in this adapter. |
| `options.memoryProvider` | **Never** mount this package as `options.memoryProvider`. Product backend is `documentStore` only. |

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

LGPL-2.1-only (same as Corbits Memory).
