/**
 * @corbits/knowledge-engine — a knowledge capture + search engine you mount
 * onto an Interchange hub.
 *
 * The host owns auth, tenancy, grants, and the process. This SDK reads the
 * request principal off the Interchange context and (optionally) taps the
 * host's grant middleware; it authenticates nothing itself.
 */
import type { Hono } from "hono";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";

import type { KnowledgeConfig } from "./mount-config.ts";
import { createKnowledgePlane, type KnowledgePlane } from "./knowledge.ts";
import {
  mountKnowledgeRoutes,
  type GrantConfig,
  type RouteDeps,
} from "./routes/mount.ts";
import { toRerankClientConfig } from "./services/search.ts";
import { validateRerankConfig } from "./core/rerank-client.ts";

// Config
export type { KnowledgeConfig } from "./mount-config.ts";
export { loadKnowledgeConfig } from "./mount-config.ts";
export type { EngineConfig } from "./config.ts";
export { RerankConfigError } from "./core/rerank-client.ts";
// Knowledge plane
//
// `createKnowledgePlane` is exported so a host can capture or search outside a
// request — a CLI seeder, a batch ingester, or a test — without standing up a
// Hono app just to get a plane. Callers acting on behalf of a user are
// responsible for the capability check `requireGrant` would have performed; see
// the README.
export { createKnowledgePlane } from "./knowledge.ts";
export type {
  KnowledgeCaptureParams,
  KnowledgeIdentity,
  KnowledgePlane,
  KnowledgeSearchParams,
  TimelineEvent,
} from "./knowledge.ts";
export { KnowledgeError } from "./knowledge.ts";
// Migrations
export { runKnowledgeMigrations } from "./migrations.ts";
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
export { mountKnowledgeRoutes, type GrantConfig } from "./routes/mount.ts";

export type MountKnowledgeEngineOptions = {
  config: KnowledgeConfig;
  /**
   * The host's grant store + condition registry — the same pair it passes to
   * `createApp`/`createRequireGrant`. Required: HTTP routes are guarded with
   * `requireGrant("knowledge", <action>)`. The SDK never leaves a route
   * unguarded.
   */
  grants: GrantConfig;
};

export type MountedKnowledgeEngine = {
  knowledge: KnowledgePlane;
};

/** Mount the knowledge HTTP routes over one knowledge plane. */
export function mountKnowledgeEngine(
  app: Hono<TenantEnv>,
  options: MountKnowledgeEngineOptions,
): MountedKnowledgeEngine {
  // Catch a chunk-size / reranker-limit mismatch here, at mount time, rather
  // than silently on every search once the reranker starts rejecting
  // batches. This throws instead of warning: a mismatch here means every
  // rerank call for this host WILL 413 and silently degrade to fused
  // ranking, with no per-request signal — a boot-time failure surfaces that
  // once, loudly, instead of leaving reranking quietly broken indefinitely.
  // This is only safe to throw on because the per-model default budget
  // (`defaultMaxDocCharsForModel`) is self-consistent by construction —
  // validation can only fire on an operator's own `maxDocChars` override,
  // never spuriously on an unmodified config, regardless of which model
  // that config resolves to.
  const rerankConfig = toRerankClientConfig(options.config.knowledge.rerank);
  if (rerankConfig) validateRerankConfig(rerankConfig);

  const knowledge = createKnowledgePlane(options.config);
  const deps: RouteDeps = {
    knowledge,
    grants: options.grants,
    requireGrant: createRequireGrant(options.grants),
  };
  mountKnowledgeRoutes(app, deps);
  return { knowledge };
}
