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

/**
 * A caller identity resolved by the host outside its browser/API-session
 * tenant middleware — e.g. a workflow-run child authenticating with its own
 * sidecar bearer token. Always wins over anything a request body claims.
 */
export type ResolvedCaller = {
  tenantId: string;
  principalId: string;
};

/**
 * Host-supplied resolver from a request to a `ResolvedCaller`, for callers
 * that never go through the host's tenant-session middleware. Return `null`
 * when the request cannot be authenticated. The package never authenticates
 * this itself — the resolver is 100% host logic (bearer-token lookup, run
 * address lookup, whatever the host's transport is).
 */
export type CallerResolver = (
  c: Context<TenantEnv>,
) => ResolvedCaller | null | Promise<ResolvedCaller | null>;

export type RouteDeps = {
  memory: Memory;
  /** Route-guard middleware factory (Interchange `createRequireGrant`). */
  requireGrant: RequireGrant;
  /** The grant store, kept for callers that need imperative checks. */
  grants: GrantConfig;
  /**
   * Optional resolver for a non-browser caller. Unset by default: every
   * route reads identity from `c.get("principal")` exactly as before, so no
   * existing host is affected. When set, it runs ahead of
   * `requirePrincipal`/`grantGuard` and its result becomes the context
   * principal/tenant those two already read — grant checks apply to a
   * machine caller through the same `requireGrant` path a browser caller
   * gets, never a separate weaker one.
   */
  callerResolver?: CallerResolver;
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

/**
 * TODO(CL-6286): resolve `deps.callerResolver` and seat the result on the
 * context ahead of `requirePrincipal`/`grantGuard`. Currently a no-op
 * passthrough — behavior is unchanged from before this ticket either way.
 */
export function resolveCaller(_deps: RouteDeps): MiddlewareHandler<TenantEnv> {
  return async (_c, next) => {
    await next();
  };
}
