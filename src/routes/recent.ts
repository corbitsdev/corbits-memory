import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

const RecentQuery = type({
  "limit?": "string",
});

const RecentResponse = type({
  events: type({
    at: "string",
    title: "string",
    source: "string",
    tenantId: "string",
    principalId: "string",
  }).array(),
});

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) return undefined;
  return n;
}

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
        400: { description: "Invalid limit query param" },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the knowledge:find grant" },
        502: { description: "Recent query failed" },
      },
    }),
    requirePrincipal(),
    grantGuard(deps, "find"),
    validator("query", RecentQuery),
    async (c) => {
      const { scopeId, subjectId } = caller(c);
      const rawLimit = c.req.valid("query").limit;
      if (
        rawLimit !== undefined &&
        rawLimit !== "" &&
        parseLimit(rawLimit) === undefined
      ) {
        return c.json({ error: "limit must be an integer from 1 to 50" }, 400);
      }
      const limit = parseLimit(rawLimit);
      try {
        const events = await deps.knowledge.recent({
          tenantId: scopeId,
          principalId: subjectId,
          ...(limit !== undefined ? { limit } : {}),
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
