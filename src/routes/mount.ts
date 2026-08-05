/**
 * Register memory HTTP routes on a host Interchange app.
 * Prefer `createMemory({ app, … })` unless you need to compose routes yourself.
 * (MCP lives in the standalone @corbitsdev/hono-openapi-mcp bridge.)
 */
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import type { RouteDeps } from "./deps.ts";
import { mountAddRoute } from "./add.ts";
import { mountSearchRoute } from "./search.ts";
import { mountListRoute } from "./list.ts";

export type { GrantConfig, RouteDeps } from "./deps.ts";

/** HTTP JSON routes: add, search, list. */
export function registerMemoryRoutes(
  app: Hono<TenantEnv>,
  deps: RouteDeps,
): void {
  mountAddRoute(app, deps);
  mountSearchRoute(app, deps);
  mountListRoute(app, deps);
}
