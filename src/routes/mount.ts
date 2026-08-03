/**
 * Mount the knowledge engine HTTP routes onto a host Interchange app.
 * (MCP moved out to the standalone @corbitsdev/hono-openapi-mcp bridge.)
 */
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import type { RouteDeps } from "./deps.ts";
import { mountAddRoute } from "./add.ts";
import { mountFindRoute } from "./find.ts";
import { mountAskRoute } from "./ask.ts";
import { mountRecentRoute } from "./recent.ts";

export type { GrantConfig, RouteDeps } from "./deps.ts";

/** HTTP JSON routes: add, find, ask, recent. */
export function mountKnowledgeRoutes(
  app: Hono<TenantEnv>,
  deps: RouteDeps,
): void {
  mountAddRoute(app, deps);
  mountFindRoute(app, deps);
  mountAskRoute(app, deps);
  mountRecentRoute(app, deps);
}
