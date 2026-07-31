import type { Context, MiddlewareHandler } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { ConditionRegistry, GrantStore } from "@intx/authz";

import type { KnowledgePlane } from "../knowledge.ts";

/**
 * The host's grant store + condition registry — the same pair it feeds
 * `createApp`/`createRequireGrant`. Used to build the route-guard middleware.
 */
export type GrantConfig = {
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
};

export type RouteDeps = {
  knowledge: KnowledgePlane;
  /** Route-guard middleware factory (Interchange `createRequireGrant`). */
  requireGrant: RequireGrant;
  /** The grant store, kept for callers that need imperative checks. */
  grants: GrantConfig;
};

/** Identity for the current request, read from the Interchange context. */
export function caller(c: Context<TenantEnv>): {
  scopeId: string;
  subjectId: string;
} {
  const principal = c.get("principal");
  if (!principal) {
    throw new Error(
      "knowledge-engine: no principal on the request context. Mount below the " +
        "host's auth + tenant middleware (the routes require TenantEnv).",
    );
  }
  return { scopeId: principal.tenantId, subjectId: principal.id };
}

/** Route-guard middleware for a knowledge action (Interchange `requireGrant`). */
export function grantGuard(
  deps: RouteDeps,
  action: string,
): MiddlewareHandler<TenantEnv> {
  return deps.requireGrant("knowledge", action);
}
