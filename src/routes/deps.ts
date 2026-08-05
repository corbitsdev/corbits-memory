import type { Context, MiddlewareHandler } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { ConditionRegistry, GrantStore } from "@intx/authz";

import type { Memory } from "../memory.ts";

/**
 * The host's grant store + condition registry — the same pair it feeds
 * `createApp`/`createRequireGrant`. Used to build the route-guard middleware.
 */
export type GrantConfig = {
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
};

export type RouteDeps = {
  memory: Memory;
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
      "memory: no principal on the request context. Mount below the " +
        "host's auth + tenant middleware (the routes require TenantEnv).",
    );
  }
  return { scopeId: principal.tenantId, subjectId: principal.id };
}

/**
 * Reject the request if the host has not put a principal on the context.
 *
 * Must run BEFORE `grantGuard`. Interchange's `requireGrant` reads
 * `principal.id` without a guard of its own, so on an unresolved context it
 * throws `TypeError: undefined is not an object` and the host sees a 500 with a
 * stack trace pointing into Interchange — which reads as this SDK being broken
 * rather than as the host missing middleware. `caller()` below has a perfectly
 * good error message for exactly this case, but it never gets to run.
 *
 * Routes mount at `/api/tenants/:tenantId/memory/*` so a real hub's
 * `createResolveTenant` already sets principal + tenant. This guard is a
 * fail-closed safety net for mis-mounted hosts and unit tests.
 */
export function requirePrincipal(): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    if (!c.get("principal")) {
      return c.json(
        {
          error: {
            code: "principal_required",
            message:
              "No principal on the request context. Mount memory under " +
              "Interchange's /api/tenants/:tenantId/* tree (or equivalent " +
              "host middleware that sets principal + tenant). See the " +
              "@corbits/memory README.",
          },
        },
        401,
      );
    }
    await next();
  };
}

/** Route-guard middleware for a memory action (Interchange `requireGrant`). */
export function grantGuard(
  deps: RouteDeps,
  action: string,
): MiddlewareHandler<TenantEnv> {
  return deps.requireGrant("memory", action);
}
