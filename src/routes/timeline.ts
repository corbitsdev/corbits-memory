import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver } from "hono-openapi";
import { type } from "arktype";

import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard } from "./deps.ts";

const TimelineResponse = type({
  events: type({
    at: "string",
    title: "string",
    source: "string",
    tenantId: "string",
    principalId: "string",
  }).array(),
});

export function mountTimelineRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.get(
    "/api/knowledge/timeline",
    describeRoute({
      tags: ["knowledge"],
      summary: "Recent captures for the caller's scope",
      responses: {
        200: {
          description: "Recent capture events",
          content: {
            "application/json": { schema: resolver(TimelineResponse) },
          },
        },
        403: { description: "Missing the knowledge:search grant" },
      },
    }),
    grantGuard(deps, "search"),
    (c) => {
      const { scopeId } = caller(c);
      const events = deps.captureLog
        .list(100)
        .filter((e) => e.tenantId === scopeId);
      return c.json({ events });
    },
  );
}
