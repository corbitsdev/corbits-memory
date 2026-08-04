# `@corbits/knowledge-adapter-mem0`

Mem0-backed [`MemoryProvider`](https://github.com/corbitsdev/corbits-knowledge-engine) for `@corbits/knowledge-engine`.

Pure HTTP (`fetch`) against the Mem0 Platform API — **no** `mem0ai` SDK dependency. Vendor code stays out of the knowledge-engine core.

## Identity mapping

Mem0 scopes memories by `user_id`. This adapter never sends a bare principal:

```ts
mapUser(tenantId, principalId) // → `${tenantId.length}:${tenantId}:${principalId.length}:${principalId}`
// e.g. mapUser("acme", "alice") → "4:acme:5:alice"
```

Empty/missing `tenantId` or `principalId` throws. Same principal under two tenants gets two distinct Mem0 users.

## Usage

```ts
import { createMem0MemoryProvider } from "@corbits/knowledge-adapter-mem0";
import { createKnowledgePlane } from "@corbits/knowledge-engine";

const memory = createMem0MemoryProvider({
  apiKey: process.env.MEM0_API_KEY!,
  // baseUrl: "https://api.mem0.ai", // optional
  // fetch: customFetch,             // optional (tests / proxies)
});

const plane = createKnowledgePlane(db, authz, {
  documentStore,
  memory,
});

await plane.remember({
  tenantId: "acme",
  principalId: "user-42",
  text: "Prefers TypeScript strict mode",
});

// ask() recalls only when includeMemory: true
const answer = await plane.ask({
  tenantId: "acme",
  principalId: "user-42",
  query: "What language preferences do I have?",
  includeMemory: true,
});
```

## Options

| Option    | Required | Description                                      |
| --------- | -------- | ------------------------------------------------ |
| `apiKey`  | yes      | Mem0 API key (`Authorization: Token …`)          |
| `baseUrl` | no       | API origin (default `https://api.mem0.ai`)       |
| `fetch`   | no       | Injectable `fetch` for tests / custom transports |

## HTTP surface

| Op       | Method | Path                   |
| -------- | ------ | ---------------------- |
| remember | POST   | `/v3/memories/add/`    |
| recall   | POST   | `/v3/memories/search/` |

Search filters always include `user_id: mapUser(tenantId, principalId)`.

## Tests

```bash
bun test
```

All tests use a mocked `fetch` — no live network.
