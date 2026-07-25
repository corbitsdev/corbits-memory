import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import { KnowledgeError } from "../knowledge.ts";
import { SearchResponseSchema } from "../core/schemas/search.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

const SearchRequest = type({
  query: "string >= 1",
  "k?": "1 <= number.integer <= 50",
});

export function mountSearchRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/knowledge/search",
    describeRoute({
      tags: ["knowledge"],
      summary: "Hybrid semantic + keyword search",
      responses: {
        200: {
          description: "Ranked hits with evidence",
          content: {
            "application/json": { schema: resolver(SearchResponseSchema) },
          },
        },
        400: { description: "Invalid query" },
        403: { description: "Missing the knowledge:search grant" },
      },
    }),
    requirePrincipal(),
    grantGuard(deps, "search"),
    validator("json", SearchRequest),
    async (c) => {
      const { query, k } = c.req.valid("json");
      const { scopeId, subjectId } = caller(c);
      try {
        const result = await deps.knowledge.search({
          query,
          tenantId: scopeId,
          principalId: subjectId,
          ...(k !== undefined ? { k } : {}),
        });
        return c.json(result);
      } catch (err) {
        const errMessage = formatCaughtError(err);
        log.error(`knowledge search failed: ${errMessage}`, { err });
        if (err instanceof KnowledgeError) {
          return c.json({ error: err.message }, err.status as 400);
        }
        return c.json({ error: "search failed" }, 502);
      }
    },
  );
}
