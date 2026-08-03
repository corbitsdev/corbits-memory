import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

const RecentResponse = type({
  events: type({
    at: "string",
    title: "string",
    source: "string",
    tenantId: "string",
    principalId: "string",
  }).array(),
});

export function mountRecentRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.get(
    "/api/knowledge/recent",
    describeRoute({
      tags: ["knowledge"],
      summary: "Recent documents for the caller's scope",
      responses: {
        200: {
          description: "Recent events visible to the caller",
          content: {
            "application/json": { schema: resolver(RecentResponse) },
          },
        },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the knowledge:find grant" },
        502: { description: "Recent query failed" },
      },
    }),
    requirePrincipal(),
    grantGuard(deps, "find"),
    async (c) => {
      const { scopeId, subjectId } = caller(c);
      try {
        const events = await deps.knowledge.recent({
          tenantId: scopeId,
          principalId: subjectId,
        });
        return c.json({ events });
      } catch (err) {
        const errMessage = formatCaughtError(err);
        log.error(`knowledge recent failed: ${errMessage}`, {
          error: errMessage,
        });
        return c.json({ error: "recent failed" }, 502);
      }
    },
  );
}
