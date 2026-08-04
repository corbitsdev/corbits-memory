# @corbits/knowledge-adapter-mem0

**Replaceable DocumentStore** for [@corbits/knowledge-engine](https://github.com/corbitsdev/corbits-knowledge-engine)
backed by the [Mem0 Platform](https://docs.mem0.ai/) HTTP API.

Pure `fetch` — **no** `mem0ai` / vendor SDK. Tenancy is enforced with a
length-prefixed `user_id` (`mapUser`) so free-form ids cannot collide.

## Product path: DocumentStore

Mem0 is a **full backend replacement** for local pgvector — not a side-channel
memory bolt-on. Mount it as `documentStore`; the plane routes `add` / `find` /
`recent` (and `ask` via find) through the store. No Postgres / embed endpoints
required.

```ts
import { createKnowledgePlane } from "@corbits/knowledge-engine";
import { createMem0DocumentStore } from "@corbits/knowledge-adapter-mem0";

const knowledge = createKnowledgePlane(undefined, grants, {
  documentStore: createMem0DocumentStore({
    apiKey: process.env.MEM0_API_KEY!,
    // baseUrl: "https://api.mem0.ai", // optional
  }),
  generate: myGenerate, // required only for ask()
});

await knowledge.add({
  tenantId,
  principalId,
  content: { title: "Prefs", text: "Prefers dark mode" },
});

const { items } = await knowledge.find({
  tenantId,
  principalId,
  query: "preferences",
});
```

Or via mount:

```ts
mountKnowledgeEngine(app, {
  documentStore: createMem0DocumentStore({ apiKey }),
  grants,
  generate,
});
```

## What is out of scope

- **Not** a tools-shaped source (Linear-style live connectors stay separate).
- **Not** the product path for `MemoryProvider` / `includeMemory` — that optional
  personal-memory port is unrelated to using Mem0 as the durable store.
- `createMem0MemoryProvider` remains exported for back-compat only; prefer
  `createMem0DocumentStore`.

## Tenant mapping

```ts
import { mapUser } from "@corbits/knowledge-adapter-mem0";

mapUser("acme", "alice"); // "4:acme:5:alice"
```

Never pass bare `principalId` as Mem0 `user_id`.

## HTTP surface (thin)

| Verb   | Method | Path                     |
| ------ | ------ | ------------------------ |
| add    | POST   | `/v3/memories/add/`      |
| find   | POST   | `/v3/memories/search/`   |
| recent | —      | empty (API has no feed)  |

Auth: `Authorization: Token <apiKey>`.

## License

LGPL-2.1-only (same as the knowledge engine).
