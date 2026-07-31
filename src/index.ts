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
import {
  createKnowledgePlane,
  type Generate,
  type KnowledgePlane,
} from "./knowledge.ts";
import {
  mountKnowledgeRoutes,
  type GrantConfig,
  type RouteDeps,
} from "./routes/mount.ts";

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
// the README. Rerank config is validated at construction (same as mount).
// Pass `grants` + optional `generate` when the host will call `ask()`.
export { createKnowledgePlane } from "./knowledge.ts";
export type {
  AskCitation,
  AskResult,
  ChatMessage,
  Generate,
  HybridSearchResult,
  KnowledgeAskParams,
  KnowledgeCaptureParams,
  KnowledgeIdentity,
  KnowledgePlane,
  KnowledgePlaneOptions,
  KnowledgeSearchParams,
  SearchHit,
  TimelineEvent,
  VisibilitySpec,
} from "./knowledge.ts";
export { KnowledgeError, KnowledgeNotPermittedError } from "./knowledge.ts";
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
   * unguarded. Also required for in-process `ask()`.
   */
  grants: GrantConfig;
  /**
   * How `ask()` reaches a model. Omit if this host only captures and searches;
   * `ask()` then fails with a 501 naming what is missing.
   *
   * The engine owns no generation client on purpose — Interchange's
   * `@intx/inference` already has provider adapters, tenant-scoped credentials,
   * retry, audit and authz gates. Wire this to that rather than to a bare fetch.
   */
  generate?: Generate;
};

export type MountedKnowledgeEngine = {
  knowledge: KnowledgePlane;
};

/** Mount the knowledge HTTP routes over one knowledge plane. */
export function mountKnowledgeEngine(
  app: Hono<TenantEnv>,
  options: MountKnowledgeEngineOptions,
): MountedKnowledgeEngine {
  // Rerank config validation runs inside createKnowledgePlane so standalone
  // construction and the mount path share one check. Pass grants + generate so
  // the returned plane's ask() is grant-checked and can synthesize answers.
  const knowledge = createKnowledgePlane(options.config, options.grants, {
    ...(options.generate ? { generate: options.generate } : {}),
  });
  const deps: RouteDeps = {
    knowledge,
    grants: options.grants,
    requireGrant: createRequireGrant(options.grants),
  };
  mountKnowledgeRoutes(app, deps);
  return { knowledge };
}
