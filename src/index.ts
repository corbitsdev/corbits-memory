/**
 * @corbits/memory — a memory add / find / ask / recent engine you
 * mount onto an Interchange hub.
 *
 * The host owns auth, tenancy, grants, and the process. This SDK reads the
 * request principal off the Interchange context and (optionally) taps the
 * host's grant middleware; it authenticates nothing itself.
 */
import type { Hono } from "hono";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";

import type { MemoryConfig } from "./mount-config.ts";
import {
  createMemory,
  type Generate,
  type Memory,
  type MemoryOptions,
  type TextExtractor,
} from "./memory.ts";
import type {
  DocumentStore,
  MemoryProvider,
  SourceProvider,
} from "./ports/types.ts";
import {
  mountMemoryRoutes,
  type GrantConfig,
  type RouteDeps,
} from "./routes/mount.ts";

// Config
export type { MemoryConfig } from "./mount-config.ts";
export { loadMemoryConfig } from "./mount-config.ts";
export type { EngineConfig } from "./config.ts";
export { RerankConfigError } from "./core/rerank-client.ts";
// Memory plane
//
// `createMemory` is exported so a host can add or find outside a
// request — a CLI seeder, a batch ingester, or a test — without standing up a
// Hono app just to get a plane. Callers acting on behalf of a user are
// responsible for the capability check `requireGrant` would have performed; see
// the README. Rerank config is validated at construction (same as mount).
// Pass `grants` + optional `generate` when the host will call `ask()`.
// One options bag — never createMemory(undefined, …).
export { createMemory } from "./memory.ts";
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
export { MemoryError, MemoryNotPermittedError } from "./memory.ts";
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
// Granular mount (compose your own)
export { mountMemoryRoutes, type GrantConfig } from "./routes/mount.ts";

export type MountMemoryOptions = {
  /**
   * Engine config (DB + model endpoints). Optional when `documentStore` is
   * provided — a host can mount with fakes only.
   */
  config?: MemoryConfig;
  /**
   * The host's grant store + condition registry — the same pair it passes to
   * `createApp`/`createRequireGrant`. Required: HTTP routes are guarded with
   * `requireGrant("memory", <action>)`. The SDK never leaves a route
   * unguarded. Also required for in-process `ask()`.
   */
  grants: GrantConfig;
  /**
   * How `ask()` reaches a model. Omit if this host only adds and finds;
   * `ask()` then fails with a 501 naming what is missing.
   *
   * The engine owns no generation client on purpose — Interchange's
   * `@intx/inference` already has provider adapters, tenant-scoped credentials,
   * retry, audit and authz gates. Wire this to that rather than to a bare fetch.
   */
  generate?: Generate;
  /** Required for `add({ file })` via HTTP or plane. */
  textExtractor?: TextExtractor;
  /** Override durable storage (default: engine pgvector store). */
  documentStore?: DocumentStore;
  /** Live source connectors merged into find/ask (fail-soft). */
  sources?: SourceProvider[];
  /**
   * Optional ask side-channel only (`includeMemory`). Not a DocumentStore
   * replacement — vendor backends mount as `documentStore`.
   */
  memoryProvider?: MemoryProvider;
};

export type MountedMemory = {
  memory: Memory;
};

/** Mount the memory HTTP routes over one memory plane. */
export function mountMemory(
  app: Hono<TenantEnv>,
  options: MountMemoryOptions,
): MountedMemory {
  // Rerank config validation runs inside createMemory so standalone
  // construction and the mount path share one check. Pass grants + generate so
  // the returned plane's ask() is grant-checked and can synthesize answers.
  const planeOptions: MemoryOptions = {
    ...(options.generate ? { generate: options.generate } : {}),
    ...(options.textExtractor ? { textExtractor: options.textExtractor } : {}),
    ...(options.documentStore ? { documentStore: options.documentStore } : {}),
    ...(options.sources ? { sources: options.sources } : {}),
    ...(options.memoryProvider
      ? { memoryProvider: options.memoryProvider }
      : {}),
  };
  const memory = createMemory({
    ...(options.config ? { config: options.config } : {}),
    grants: options.grants,
    ...planeOptions,
  });
  const deps: RouteDeps = {
    memory,
    grants: options.grants,
    requireGrant: createRequireGrant(options.grants),
  };
  mountMemoryRoutes(app, deps);
  return { memory };
}
