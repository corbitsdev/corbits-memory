import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
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
          description: "Recent capture events visible to the caller",
          content: {
            "application/json": { schema: resolver(TimelineResponse) },
          },
        },
        403: { description: "Missing the knowledge:search grant" },
      },
    }),
    grantGuard(deps, "search"),
    async (c) => {
      const { scopeId, subjectId } = caller(c);
      try {
        const events = await deps.knowledge.timeline({
          tenantId: scopeId,
          principalId: subjectId,
        });
        return c.json({ events });
      } catch (err) {
        const errMessage = formatCaughtError(err);
        log.error(`knowledge timeline failed: ${errMessage}`, {
          error: errMessage,
        });
        return c.json({ error: "timeline failed" }, 502);
      }
    },
  );
}
