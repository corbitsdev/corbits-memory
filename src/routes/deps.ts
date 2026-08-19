import type { Context, MiddlewareHandler } from "hono";
import type {
  PrincipalRow,
  RequireGrant,
  TenantEnv,
  TenantRow,
} from "@intx/hub-api";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import { type } from "arktype";

import { log } from "../log.ts";
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

/**
 * `"string >= 1"` is a LENGTH constraint, not a content one — `" "` has
 * length 1 and would pass it, seating a whitespace-only scope exactly like
 * the empty-string case this schema exists to reject. Require at least one
 * non-whitespace character instead.
 */
const NonBlankId = type("string").narrow(
  (s, ctx) => s.trim().length > 0 || ctx.mustBe("non-blank (not just whitespace)"),
);

/**
 * The one boundary where a host hands this package an identity, so it is
 * parsed like any other trust boundary (AGENTS.md invariant 4) rather than
 * trusted as an opaque TS shape. A resolver returning `{tenantId: "",
 * principalId: ""}` or `{tenantId: " ", principalId: " "}` (or anything not
 * matching this shape) is rejected here, never seated as a "valid"
 * empty/blank scope.
 */
const ResolvedCallerSchema = type({
  tenantId: NonBlankId,
  principalId: NonBlankId,
});

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
 * `requireGrant`/`authorize` only ever read `.id` off the tenant/principal
 * rows they're handed; the rest of `PrincipalRow`/`TenantRow` describes a
 * browser-session database row a bearer-token caller has none of. These
 * placeholders exist only to satisfy that shape.
 */
function principalRowFor(resolved: ResolvedCaller): PrincipalRow {
  return {
    id: resolved.principalId,
    tenantId: resolved.tenantId,
    kind: "agent",
    refId: resolved.principalId,
    status: "active",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function tenantRowFor(resolved: ResolvedCaller): TenantRow {
  return {
    id: resolved.tenantId,
    name: resolved.tenantId,
    slug: resolved.tenantId,
    domain: "",
    parentId: null,
    config: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/**
 * When `deps.callerResolver` is set, resolve the caller and seat it as the
 * context principal/tenant before `requirePrincipal`/`grantGuard` run — a
 * request the resolver rejects never reaches them. When unset, this is a
 * no-op passthrough; the host's own tenant-session middleware remains the
 * only thing that ever sets `principal`/`tenant`, exactly as before this
 * ticket.
 *
 * `null` means "this caller could not be authenticated" — a caller problem,
 * so 401. A resolved value that fails `ResolvedCallerSchema` means the
 * host's own resolver is broken (empty strings, wrong types, wrong shape) —
 * a host bug, not a caller's, so 500 rather than 401: the request is not
 * "unauthorized," the identity provider is misbehaving.
 */
export function resolveCaller(deps: RouteDeps): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    if (!deps.callerResolver) {
      await next();
      return;
    }
    const resolved = await deps.callerResolver(c);
    if (!resolved) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message:
              "The configured caller resolver could not identify this " +
              "request (missing or unrecognized credentials).",
          },
        },
        401,
      );
    }
    const parsed = ResolvedCallerSchema(resolved);
    if (parsed instanceof type.errors) {
      log.error(
        `memory: callerResolver returned a malformed identity: ${parsed.summary}`,
      );
      return c.json(
        {
          error: {
            code: "invalid_resolved_caller",
            message:
              "The configured caller resolver returned an identity that " +
              "does not match { tenantId, principalId } (non-empty " +
              "strings). This is a host misconfiguration.",
          },
        },
        500,
      );
    }
    c.set("principal", principalRowFor(parsed));
    c.set("tenant", tenantRowFor(parsed));
    await next();
  };
}
