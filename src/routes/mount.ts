/**
 * Register memory HTTP routes on a host Interchange app.
 * Prefer `createMemory({ app, … })` unless you need to compose routes yourself.
 * (MCP lives in the standalone @corbitsdev/hono-openapi-mcp bridge.)
 *
 * The `:tenantId` in `/api/tenants/:tenantId/memory/*` is never read by any
 * handler — it exists only so the route shares a path shape with the rest
 * of the host's `/api/tenants/:tenantId/*` tree. Every scope actually comes
 * from `caller(c)` (context `principal`/`tenant`, set by the host's
 * tenant-session middleware or, for a machine caller, by `resolveCaller`
 * from `RouteDeps.callerResolver`) — never the URL.
 */
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import type { RouteDeps } from "./deps.ts";
import { mountAddRoute } from "./add.ts";
import { mountSearchRoute } from "./search.ts";
import { mountListRoute } from "./list.ts";
import { mountFeedRoute } from "./feed.ts";
import {
  mountForgetRoute,
  mountPurgeRoute,
  mountSetRetentionClassRoute,
} from "./retention.ts";

export type {
  CallerResolver,
  GrantConfig,
  ResolvedCaller,
  RouteDeps,
} from "./deps.ts";

/** HTTP JSON routes: add, search, list, feed, forget, purge, retention-class. */
export function registerMemoryRoutes(
  app: Hono<TenantEnv>,
  deps: RouteDeps,
): void {
  mountAddRoute(app, deps);
  mountSearchRoute(app, deps);
  mountListRoute(app, deps);
  mountFeedRoute(app, deps);
  mountForgetRoute(app, deps);
  mountPurgeRoute(app, deps);
  mountSetRetentionClassRoute(app, deps);
}
