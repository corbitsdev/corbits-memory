# `@corbits/knowledge-adapter-supermemory`

Supermemory adapter for the Corbits Knowledge Engine `MemoryProvider` port.

Pure `fetch` HTTP — **no** `supermemory` npm SDK.

## Install

```bash
bun add @corbits/knowledge-adapter-supermemory
```

## Usage

```ts
import {
  createSupermemoryMemoryProvider,
  containerTag,
} from "@corbits/knowledge-adapter-supermemory";

const memory = createSupermemoryMemoryProvider({
  apiKey: process.env.SUPERMEMORY_API_KEY!,
  // baseUrl?: "https://api.supermemory.ai"  // or self-hosted
  // fetch?: myFetch                         // injectable for tests
});

// Mount on the knowledge plane
// createKnowledgePlane({ …, memory })
```

### Container tags

Tenant isolation maps to Supermemory `containerTag`:

```
t_{tenantId}_u_{principalId}
```

Example: `containerTag("acme", "alice")` → `t_acme_u_alice`.

Empty `tenantId` / `principalId` are rejected.

### Recall

`recall` always sends `searchMode: "memories"` (extracted facts only). It never
relies on the API default.

| Method   | HTTP                         |
| -------- | ---------------------------- |
| remember | `POST /v3/documents`         |
| recall   | `POST /v4/search`            |

## Tests

```bash
bun test
```

All network is mocked; no live Supermemory calls.
