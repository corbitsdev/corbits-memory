/**
 * Mount the knowledge engine HTTP routes onto a host Interchange app.
 * (MCP moved out to the standalone @corbitsdev/hono-openapi-mcp bridge.)
 */
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import type { RouteDeps } from "./deps.ts";
import { mountCaptureRoute } from "./capture.ts";
import { mountSearchRoute } from "./search.ts";
import { mountTimelineRoute } from "./timeline.ts";

export type { GrantConfig, RouteDeps } from "./deps.ts";

/** HTTP JSON routes: capture, search, timeline. */
export function mountKnowledgeRoutes(
  app: Hono<TenantEnv>,
  deps: RouteDeps,
): void {
  mountSearchRoute(app, deps);
  mountCaptureRoute(app, deps);
  mountTimelineRoute(app, deps);
}
