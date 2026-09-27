/**
 * @corbits/memory — add / search / list for Interchange hubs.
 *
 * `createMemory(options)` builds the plane; `createMemoryRoutes(deps)`
 * returns its HTTP routes as a Hono sub-app for the host to mount. Identity
 * is `c.get("principal")` on HTTP, or `principalId` + `tenantId` in-process.
 * Authz is the host grant store — this package authenticates nothing itself.
 *
 * The resident distiller ships at `@corbits/memory/distiller`, migrations at
 * `@corbits/memory/migrations`.
 */

// Config
export type { MemoryConfig } from "./mount-config.js";
export { loadMemoryConfig } from "./mount-config.js";
export type { EngineConfig } from "./config.js";
export { RerankConfigError } from "./core/rerank-client.js";

// Memory plane
export type {
  HybridSearchResult,
  MemoryAddParams,
  MemoryAddResult,
  MemoryCapabilities,
  MemorySearchParams,
  MemoryIdentity,
  Memory,
  MemoryOptions,
  MemoryListParams,
  MemoryFeedParams,
  MemoryFeedEntry,
  MemoryFeedResult,
  MemoryShare,
  SearchHit,
  SearchItem,
  SearchAttribution,
  SearchResult,
  TextExtractor,
  TimelineEvent,
} from "./memory.js";
export {
  createMemory,
  MemoryError,
  SEARCH_LIMIT_MIN,
  SEARCH_LIMIT_MAX,
  LIST_LIMIT_MIN,
  LIST_LIMIT_MAX,
} from "./memory.js";

// HTTP routes
export {
  createMemoryRoutes,
  type CallerResolver,
  type ResolvedCaller,
  type RouteDeps,
} from "./routes/mount.js";

// Installer discovery — grant *requirements* (not live grants)
export {
  capabilityIdsForSurface,
  MEMORY_CAPABILITY_IDS,
  MEMORY_GRANT_REQUIREMENTS,
  type MemoryGrantRequirement,
  type MemoryGrantInstallHint,
  type MemoryGrantSurface,
} from "./grant-requirements.js";

// Ports — pluggable storage and live sources
export type {
  DocumentStore,
  DocumentStoreAddParams,
  DocumentStoreAddResult,
  DocumentStoreCapabilities,
  DocumentStoreSearchItem,
  DocumentStoreSearchParams,
  DocumentStoreSearchResult,
  DocumentStoreListEvent,
  DocumentStoreListParams,
  LiveSearchItem,
  SourceProvider,
} from "./ports/types.js";
export type { WritableGrantStore } from "./ports/writable-grant-store.js";

// Run-scoped routes for deployed agents (bearer + run address, no session).
// The tools that call them ship at `@corbits/memory/sidecar-bundle`.
export { mountWorkflowMemory } from "./workflow-mount.js";
export type {
  AgentTokenAuth,
  AgentTokenIdentity,
  MountWorkflowMemoryOpts,
  ResolvedWorkflowRunScope,
  WorkflowMemoryEnv,
} from "./workflow-mount.js";
export { MEMORY_TOOL_DEFINITIONS, type MemoryToolDefinition } from "./tools.js";

// Host-side HTTP client for the tenant routes (the imperative distill tick).
export {
  createMemoryHttpClient,
  type MemoryAddBody,
  type MemoryHttpClient,
  type MemoryHttpConfig,
  type MemorySearchBody,
} from "./http-client.js";
