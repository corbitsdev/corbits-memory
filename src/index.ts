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
import { CaptureLog } from "./capture-log.ts";
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
// Knowledge plane + capture log
export type { KnowledgePlane } from "./knowledge.ts";
export { CaptureLog, type CaptureEvent } from "./capture-log.ts";
// Migrations
export { runKnowledgeMigrations } from "./migrations.ts";
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
  captureLog: CaptureLog;
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
  // This is only safe to throw on because the shipped defaults are
  // self-consistent (see TEI_MAX_DOC_CHARS) — validation can only fire on an
  // operator's own override, never spuriously on an unmodified config.
  const rerankConfig = toRerankClientConfig(options.config.knowledge.rerank);
  if (rerankConfig) validateRerankConfig(rerankConfig);

  const knowledge = createKnowledgePlane(options.config);
  const captureLog = new CaptureLog();
  const deps: RouteDeps = {
    knowledge,
    captureLog,
    grants: options.grants,
    requireGrant: createRequireGrant(options.grants),
  };
  mountKnowledgeRoutes(app, deps);
  return { knowledge, captureLog };
}
