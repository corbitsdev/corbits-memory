# @corbits/knowledge-adapter-mem0

**Replaceable DocumentStore** for [@corbits/memory](https://github.com/corbitsdev/corbits-memory)
backed by the [Mem0 Platform](https://docs.mem0.ai/) HTTP API.

Pure `fetch` — **no** `mem0ai` / vendor SDK. Tenancy is enforced with a
length-prefixed `user_id` (`mapUser`) so free-form ids cannot collide.

## Product path: DocumentStore

Mount Mem0 as `documentStore` so the plane routes `add` / `find` / `recent`
(and `ask` via find) through this store — no Postgres / embed endpoints
required. This is the product integration path (not `MemoryProvider` /
`includeMemory`).

```ts
import { createMemory } from "@corbits/memory";
import { createMem0DocumentStore } from "@corbits/knowledge-adapter-mem0";

const memory = createMemory(undefined, grants, {
  documentStore: createMem0DocumentStore({
    apiKey: process.env.MEM0_API_KEY!,
    // baseUrl: "https://api.mem0.ai", // optional
  }),
  generate: myGenerate, // required only for ask()
});

await memory.add({
  tenantId,
  principalId,
  content: { title: "Prefs", text: "Prefers dark mode" },
});

const { items } = await memory.find({
  tenantId,
  principalId,
  query: "preferences",
});
```

Or via mount:

```ts
mountMemory(app, {
  documentStore: createMem0DocumentStore({ apiKey }),
  grants,
  generate,
});
```

## Limitations (honest)

| Area | Behavior |
| --- | --- |
| Isolation | **Principal-bucket only** via `mapUser(tenantId, principalId)`. Each principal has a private Mem0 `user_id`; docs are not shared across principals. |
| Document access | This adapter is **principal-bucket only**. Host grant tags (`accessTags`) are stored as metadata at best and are **not** evaluated. For multi-principal grant-tag ACL, use the default pgvector store. |
| `recent` | Always `[]` — Mem0 has no recent-feed API here. |
| `options.memoryProvider` | **Never** mount this package as `options.memoryProvider`. That port is an ask side-channel; Mem0 as product backend is `documentStore` only. |

## What is out of scope

- **Not** a tools-shaped source (Linear-style live connectors stay separate).
- **Not** the product path for `MemoryProvider` / `includeMemory`.
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

LGPL-2.1-only (same as Corbits Memory).
