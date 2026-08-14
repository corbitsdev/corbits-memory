/**
 * Interchange `defineTool` factories for hub memory routes.
 *
 * Install on a workflow like any other open tool package. Each factory
 * requires env: `memoryBaseUrl`, `memoryTenantId`, `memoryAuthToken`.
 * Tools call `/api/tenants/:tenantId/memory/*` over HTTP — no plane DI.
 */

export { memoryAdd } from "./add.ts";
export { memorySearch } from "./search.ts";
export { memoryList } from "./list.ts";
export { memoryFeed } from "./feed.ts";
export {
  createMemoryHttpClient,
  MEMORY_TOOL_ENV_KEYS,
  type MemoryHttpClient,
  type MemoryHttpConfig,
  type MemoryToolEnv,
} from "./client.ts";

/** Re-export installer grant requirements (same as package root). */
export {
  MEMORY_CAPABILITY_IDS,
  MEMORY_GRANT_REQUIREMENTS,
  type MemoryGrantRequirement,
  type MemoryGrantSource,
  type MemoryGrantSurface,
} from "../grant-requirements.ts";

