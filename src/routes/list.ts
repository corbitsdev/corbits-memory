import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import { ListQuery, parseListLimitString } from "../http-bodies.ts";
import {
  MemoryError,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
} from "../memory.ts";
import type { RouteDeps } from "./deps.ts";
import {
  caller,
  grantGuard,
  requirePrincipal,
  resolveCaller,
} from "./deps.ts";

const ListResponse = type({
  events: type({
    at: "string",
    title: "string",
    source: "string",
    tenantId: "string",
    principalId: "string",
  }).array(),
});

export function mountListRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.get(
    "/api/tenants/:tenantId/memory/list",

    describeRoute({
      tags: ["memory"],
      summary: "List recent documents for the caller's scope",
      responses: {
        200: {
          description: "Events visible to the caller",
          content: {
            "application/json": { schema: resolver(ListResponse) },
          },
        },
        400: { description: "Invalid limit query param" },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the memory:search grant" },
        502: { description: "List query failed" },
      },
    }),
    resolveCaller(deps),
    requirePrincipal(),
    grantGuard(deps, "search"),
    validator("query", ListQuery),
    async (c) => {
      const { scopeId, subjectId } = caller(c);
      const rawLimit = c.req.valid("query").limit;
      const parsedLimit = parseListLimitString(rawLimit);
      if (parsedLimit === null) {
        return c.json(
          {
            error: `limit must be an integer from ${LIST_LIMIT_MIN} to ${LIST_LIMIT_MAX}`,
          },
          400,
        );
      }
      const limit = parsedLimit;
      try {
        const events = await deps.memory.list({
          tenantId: scopeId,
          principalId: subjectId,
          ...(limit !== undefined ? { limit } : {}),
        });
        return c.json({ events });
      } catch (err) {
        if (err instanceof MemoryError) {
          return c.json({ error: err.message }, err.status as 400);
        }
        const errMessage = formatCaughtError(err);
        log.error(`memory list failed: ${errMessage}`, {
          error: errMessage,
        });
        return c.json({ error: "list failed" }, 502);
      }
    },
  );
}
