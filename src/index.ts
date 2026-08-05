/**
 * @corbits/memory — add / find / ask / recent for Interchange hubs.
 *
 * One entry: `createMemory(options)`. Pass `app` to register HTTP routes on
 * a Hono host. Identity is `c.get("principal")` on HTTP, or `principalId` +
 * `tenantId` in-process. Authz is the host grant store — this package
 * authenticates nothing itself.
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
  AskCitation,
  AskResult,
  ChatMessage,
  FindItem,
  FindResult,
  Generate,
  HybridSearchResult,
  MemoryAddParams,
  MemoryAddResult,
  MemoryAskParams,
  MemoryFindParams,
  MemoryIdentity,
  Memory,
  MemoryOptions,
  MemoryRecentParams,
  MemoryRecallItem,
  MemoryRecallParams,
  MemoryRememberParams,
  MemoryShare,
  SearchHit,
  TextExtractor,
  TimelineEvent,
} from "./memory.ts";
export {
  MemoryError,
  MemoryNotPermittedError,
  resolveGrantConfig,
} from "./memory.ts";

// Ports — pluggable storage, live sources, and optional memory
export type {
  DocumentStore,
  DocumentStoreAddParams,
  DocumentStoreFindItem,
  DocumentStoreFindParams,
  DocumentStoreFindResult,
  DocumentStoreRecentEvent,
  DocumentStoreRecentParams,
  LiveSearchItem,
  MemoryProvider,
  SourceProvider,
} from "./ports/types.ts";

export {
  createFakeDocumentStore,
  createFakeMemoryProvider,
  createFakeSourceProvider,
} from "./ports/fakes.ts";

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
   * When set, register `/api/memory/*` on this Hono app. Requires `grantStore`
   * (routes are guarded with `requireGrant("memory", …)`).
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
 * await memory.add({ tenantId, principalId, content: { title, text } });
 * ```
 *
 * @example With HTTP
 * ```ts
 * const memory = createMemory({
 *   app,
 *   grantStore,
 *   conditionRegistry,
 *   config: loadMemoryConfig(),
 *   generate,
 * });
 * ```
 */
export function createMemory(options: CreateMemoryOptions = {}): Memory {
  const { app, ...planeOptions } = options;
  const memory = createMemoryPlane(planeOptions);
  if (app) {
    const grants = resolveGrantConfig(options);
    if (!grants) {
      throw new Error(
        "createMemory({ app }): grantStore is required to register HTTP routes",
      );
    }
    const deps: RouteDeps = {
      memory,
      grants,
      requireGrant: createRequireGrant(grants),
    };
    registerMemoryRoutes(app, deps);
  }
  return memory;
}
