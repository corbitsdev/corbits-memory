/**
 * Memory HTTP routes as a typed Hono sub-app. The host mounts it under its
 * tenant tree, below the middleware that sets `principal`/`tenant`:
 *
 * ```ts
 * app.route(
 *   "/api/tenants/:tenantId/memory",
 *   createMemoryRoutes({ memory, requireGrant }),
 * );
 * ```
 *
 * The `:tenantId` in that prefix is never read by any handler — it exists
 * only so the routes share a path shape with the rest of the host's
 * `/api/tenants/:tenantId/*` tree. Every scope actually comes from
 * `caller(c)` (context `principal`/`tenant`, set by the host's
 * tenant-session middleware or, for a machine caller, by `resolveCaller`
 * from `RouteDeps.callerResolver`) — never the URL.
 */
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import type { RouteDeps } from "./deps.js";
import { mountAddRoute } from "./add.js";
import { mountSearchRoute } from "./search.js";
import { mountListRoute } from "./list.js";
import { mountFeedRoute } from "./feed.js";
import {
  mountForgetRoute,
  mountPurgeRoute,
  mountSetRetentionClassRoute,
} from "./retention.js";

export type { CallerResolver, ResolvedCaller, RouteDeps } from "./deps.js";

/** HTTP JSON routes: add, search, list, feed, forget, purge, retention-class. */
export function createMemoryRoutes(deps: RouteDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  mountAddRoute(app, deps);
  mountSearchRoute(app, deps);
  mountListRoute(app, deps);
  mountFeedRoute(app, deps);
  mountForgetRoute(app, deps);
  mountPurgeRoute(app, deps);
  mountSetRetentionClassRoute(app, deps);
  return app;
}
