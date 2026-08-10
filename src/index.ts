/**
 * @corbits/memory — add / search / list for Interchange hubs.
 *
 * One entry: `createMemory(options)`. Pass `app` to register HTTP routes on
 * a Hono host. Identity is `c.get("principal")` on HTTP, or `principalId` +
 * `tenantId` in-process. Authz is the host grant store — this package
 * authenticates nothing itself.
 *
 * Inference is host-owned and ephemeral (call your model, then add/search).
 * Core does not mount an ingest agent or bake LLM into the write path.
 */
import type { Hono } from "hono";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";

import {
  createMemory as createMemoryPlane,
  resolveGrantConfig,
  type Memory,
  type MemoryOptions,
} from "./memory.ts";
import {
  registerMemoryRoutes,
  type RouteDeps,
} from "./routes/mount.ts";

// Config
export type { MemoryConfig } from "./mount-config.ts";
export { loadMemoryConfig } from "./mount-config.ts";
export type { EngineConfig } from "./config.ts";
export { RerankConfigError } from "./core/rerank-client.ts";

// Memory plane — types from memory.ts; createMemory is defined below so it
// can optionally register HTTP routes when `app` is passed.
export type {
  HybridSearchResult,
  MemoryAddParams,
  MemoryAddResult,
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
} from "./memory.ts";
export {
  MemoryError,
  resolveGrantConfig,
  SEARCH_LIMIT_MIN,
  SEARCH_LIMIT_MAX,
  LIST_LIMIT_MIN,
  LIST_LIMIT_MAX,
} from "./memory.ts";

// Ports — pluggable storage and live sources
export type {
  DocumentStore,
  DocumentStoreAddParams,
  DocumentStoreAddResult,
  DocumentStoreSearchItem,
  DocumentStoreSearchParams,
  DocumentStoreSearchResult,
  DocumentStoreListEvent,
  DocumentStoreListParams,
  LiveSearchItem,
  SourceProvider,
} from "./ports/types.ts";

export {
  createFakeDocumentStore,
  createFakeSourceProvider,
} from "./ports/fakes.ts";

export type { WritableGrantStore } from "./ports/writable-grant-store.ts";
export {
  createInMemoryWritableGrantStore,
  isWritableGrantStore,
} from "./ports/writable-grant-store.ts";

// Share materialization (CL-5873)
export {
  buildShareGrants,
  documentTag,
  materializeShareGrants,
  MEMORY_SHARE_CONDITION_KEY,
  MEMORY_SHARE_CONDITION_REGISTRY,
  shareWidenReceipt,
  splitAudienceWiden,
  type MaterializeShareGrantsInput,
  type MemoryShareCondition,
  type ShareWidenReceipt,
} from "./services/share-grants.ts";


// Transform / replay surface (CL-5872)
export {
  createTransformConfig,
  demoteGeneration,
  listTransformConfigs,
  promoteGeneration,
  resolveGenerationSearchParams,
  runTransform,
  TransformConfigNotFoundError,
  TransformPromoteError,
  type GenerationSearchParams,
  type TransformConfigRow,
  type TransformRunRow,
} from "./services/transform.ts";

// Capture feed (CL-5868)
export {
  fetchFeed,
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  FEED_LIMIT_MIN,
  type FeedArgs,
  type FeedEntry,
  type FeedResult,
} from "./services/feed.ts";

// Corroboration / living relevancy (CL-5867)
export {
  corroborationFactor,
  CORROBORATION_COUNT_LOG_CAP,
  CORROBORATION_STRONG_FLOOR,
  effectiveAuthority,
  meetsStrongEvidenceGate,
  type CorroborationCounts,
  type StrongEvidenceSignals,
} from "./core/corroboration.ts";

// Embed model registry (ensure vs activate)
export {
  activateEmbedModel,
  activateEmbedModelByKey,
  clearActiveEmbedModels,
  ensureEmbedModel,
  resolveActiveEmbedTable,
  resolveEmbedTableByModelKey,
} from "./core/embed-model-registry.ts";


// Migrations
export { runMemoryMigrations } from "./migrations.ts";

// Degrade metrics — no metrics dependency exists in this package (see
// core/degrade-metrics.ts); a host with its own metrics backend polls this
// snapshot and forwards it, rather than the engine owning a /metrics port.
export {
  getDegradeMetricsSnapshot,
  getAllDegradeMetricsSnapshots,
  configureDegradeMetrics,
  type DegradeMetricsSnapshot,
  type DegradeMetricsConfig,
} from "./core/degrade-metrics.ts";
export {
  DEFAULT_FTS_LANGUAGE,
  type FtsVerifySqlClient,
  parseFtsLanguage,
  verifyFtsLanguage,
} from "./core/fts-language.ts";

// Granular HTTP composition (most hosts use createMemory({ app, … }) instead)
export { registerMemoryRoutes, type GrantConfig } from "./routes/mount.ts";

export type CreateMemoryOptions = MemoryOptions & {
  /**
   * When set, register `/api/tenants/:tenantId/memory/*` on this Hono app.
   * Requires `grantStore` (routes are guarded with `requireGrant("memory", …)`).
   * On a real hub, mount under the same app that already runs
   * `createResolveTenant` on `/api/tenants/:tenantId/*`.
   */
  app?: Hono<TenantEnv>;
};

/**
 * Build a memory plane. Optionally register HTTP routes when `app` is set.
 *
 * @example In-process only
 * ```ts
 * const memory = createMemory({
 *   documentStore: createFakeDocumentStore(),
 *   grantStore,
 *   conditionRegistry,
 * });
 * await memory.add({ principalId, tenantId, content: { title, text } });
 * const { items } = await memory.search({ principalId, tenantId, query });
 * ```
 *
 * @example HTTP on a Hono host
 * ```ts
 * createMemory({
 *   app,
 *   documentStore: createFakeDocumentStore(),
 *   grantStore,
 *   conditionRegistry,
 * });
 * // POST …/memory/add | search · GET …/memory/list
 * // under /api/tenants/:tenantId/
 * ```
 */
export function createMemory(options: CreateMemoryOptions): Memory {
  const { app, grantStore, conditionRegistry, ...planeOpts } = options;
  const grants = resolveGrantConfig({
    ...(grantStore !== undefined ? { grantStore } : {}),
    ...(conditionRegistry !== undefined ? { conditionRegistry } : {}),
  });
  const memory = createMemoryPlane({
    ...planeOpts,
    ...(grantStore !== undefined ? { grantStore } : {}),
    ...(conditionRegistry !== undefined ? { conditionRegistry } : {}),
  });

  if (app) {
    if (!grants) {
      throw new Error(
        "createMemory({ app }): grantStore is required when registering HTTP routes " +
          "(pass grantStore; conditionRegistry is optional)",
      );
    }
    const requireGrant = createRequireGrant(grants);
    const deps: RouteDeps = {
      memory,
      requireGrant,
      grants,
    };
    registerMemoryRoutes(app, deps);
  }

  return memory;
}
