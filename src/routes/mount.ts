/**
 * Register memory HTTP routes on a host Interchange app.
 * Prefer `createMemory({ app, … })` unless you need to compose routes yourself.
 * (MCP lives in the standalone @corbitsdev/hono-openapi-mcp bridge.)
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
export function registerMemoryRoutes(
  app: Hono<TenantEnv>,
  deps: RouteDeps,
): void {
  mountAddRoute(app, deps);
  mountFindRoute(app, deps);
  mountAskRoute(app, deps);
  mountRecentRoute(app, deps);
}
