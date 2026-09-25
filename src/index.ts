/**
 * @corbits/memory — add / search / list for Interchange hubs.
 *
 * One entry: `createMemory(options)`. Pass `app` to register HTTP routes on
 * a Hono host. Identity is `c.get("principal")` on HTTP, or `principalId` +
 * `tenantId` in-process. Authz is the host grant store — this package
 * authenticates nothing itself.
 *
 * Distiller is first-class: `createResidentDistiller` / `runDistillTick` from
 * `@corbits/memory/distiller` (or re-exported below). Inference stays host-
 * injected; the package ships the workflow + tick helpers so apps opt in
 * with a few lines.
 */
import type { Hono } from "hono";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";

import {
  createMemory as createMemoryPlane,
  resolveGrantConfig,
  type Memory,
  type MemoryOptions,
} from "./memory.js";
import {
  registerMemoryRoutes,
  type CallerResolver,
  type RouteDeps,
} from "./routes/mount.js";

// Config
export type { MemoryConfig } from "./mount-config.js";
export { loadMemoryConfig } from "./mount-config.js";
export type { EngineConfig } from "./config.js";
export { RerankConfigError } from "./core/rerank-client.js";

// Memory plane — types from memory.ts; createMemory is defined below so it
// can optionally register HTTP routes when `app` is passed.
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
  MemoryError,
  resolveGrantConfig,
  SEARCH_LIMIT_MIN,
  SEARCH_LIMIT_MAX,
  LIST_LIMIT_MIN,
  LIST_LIMIT_MAX,
} from "./memory.js";

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

export {
  createFakeDocumentStore,
  createFakeSourceProvider,
} from "./ports/fakes.js";

export type { WritableGrantStore } from "./ports/writable-grant-store.js";
export {
  createInMemoryWritableGrantStore,
  isWritableGrantStore,
} from "./ports/writable-grant-store.js";

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
} from "./services/share-grants.js";


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
} from "./services/transform.js";

// Capture feed (CL-5868)
export {
  fetchFeed,
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  FEED_LIMIT_MIN,
  type FeedArgs,
  type FeedEntry,
  type FeedResult,
} from "./services/feed.js";

// Retention / forgetting (CL-5871)
export {
  deprecateVersion,
  hardDeleteDocument,
  setRetentionClass,
  sweepEphemeral,
  tombstoneDocument,
  type RetentionMutationResult,
} from "./services/retention.js";

// Resident distiller (CL-5869) — also `@corbits/memory/distiller`
export {
  RESIDENT_DISTILLER_AGENT_ID,
  RESIDENT_DISTILLER_WORKFLOW_ID,
  buildDistilledClaim,
  createResidentDistiller,
  resolveNextCursor,
  runDistillTick,
  shouldProcessFeedEntry,
  type BuildDistilledClaimArgs,
  type CreateResidentDistillerOpts,
  type DistillOutcome,
  type DistillTickFeedEntry,
  type DistillTickPage,
  type DistillTickResult,
  type DistilledClaimWrite,
  type FeedEntryLike,
  type ResidentDistiller,
  type RunDistillTickArgs,
} from "./distiller/index.js";

// Corroboration / living relevancy (CL-5867)
export {
  corroborationFactor,
  CORROBORATION_COUNT_LOG_CAP,
  CORROBORATION_STRONG_FLOOR,
  effectiveAuthority,
  meetsStrongEvidenceGate,
  type CorroborationCounts,
  type StrongEvidenceSignals,
} from "./core/corroboration.js";

// Embed model registry (ensure vs activate)
export {
  activateEmbedModel,
  activateEmbedModelByKey,
  clearActiveEmbedModels,
  ensureEmbedModel,
  resolveActiveEmbedTable,
  resolveEmbedTableByModelKey,
} from "./core/embed-model-registry.js";


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

// Migrations
export { runMemoryMigrations } from "./migrations.js";

// Degrade metrics — no metrics dependency exists in this package (see
// core/degrade-metrics.ts); a host with its own metrics backend polls this
// snapshot and forwards it, rather than the engine owning a /metrics port.
export {
  getDegradeMetricsSnapshot,
  getAllDegradeMetricsSnapshots,
  configureDegradeMetrics,
  type DegradeMetricsSnapshot,
  type DegradeMetricsConfig,
} from "./core/degrade-metrics.js";
export {
  DEFAULT_FTS_LANGUAGE,
  type FtsVerifySqlClient,
  parseFtsLanguage,
  verifyFtsLanguage,
} from "./core/fts-language.js";

// Granular HTTP composition (most hosts use createMemory({ app, … }) instead)
export {
  registerMemoryRoutes,
  type CallerResolver,
  type GrantConfig,
  type ResolvedCaller,
} from "./routes/mount.js";

export type CreateMemoryOptions = MemoryOptions & {
  /**
   * When set, register `/api/tenants/:tenantId/memory/*` on this Hono app.
   * Requires `grantStore` (routes are guarded with `requireGrant("memory", …)`).
   * On a real hub, mount under the same app that already runs
   * `createResolveTenant` on `/api/tenants/:tenantId/*`.
   */
  app?: Hono<TenantEnv>;
  /**
   * Resolver for a caller that never goes through the host's tenant-session
   * middleware — e.g. a workflow-run child authenticating with its own
   * sidecar bearer token. Unset by default: every route reads identity from
   * `c.get("principal")` exactly as before. See `CallerResolver`.
   */
  callerResolver?: CallerResolver;
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
  const { app, callerResolver, grantStore, conditionRegistry, ...planeOpts } =
    options;
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
      ...(callerResolver !== undefined ? { callerResolver } : {}),
    };
    registerMemoryRoutes(app, deps);
  }

  return memory;
}
