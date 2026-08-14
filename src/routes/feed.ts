import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import { FeedQuery, parseFeedQuery } from "../http-bodies.ts";
import { MemoryError } from "../memory.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

const FeedResponse = type({
  entries: type({
    feedSeq: "number",
    versionId: "string",
    documentId: "string",
    kind: "string",
    title: "string",
    status: "string",
    createdByKind: "string",
    generatorAgentId: "string|null",
    provenance: "string",
    occurredAt: "string",
    createdAt: "string",
    accessTags: "string[]",
  }).array(),
  nextCursor: "number|null",
});

export function mountFeedRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.get(
    "/api/tenants/:tenantId/memory/feed",

    describeRoute({
      tags: ["memory"],
      summary: "Pull new live versions after a cursor (capture feed)",
      responses: {
        200: {
          description: "Ordered feed page",
          content: {
            "application/json": { schema: resolver(FeedResponse) },
          },
        },
        400: { description: "Invalid query params" },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the memory:search grant" },
        501: { description: "Feed requires the engine DocumentStore" },
        502: { description: "Feed query failed" },
      },
    }),
    requirePrincipal(),
    grantGuard(deps, "search"),
    validator("query", FeedQuery),
    async (c) => {
      const { scopeId, subjectId } = caller(c);
      const parsed = parseFeedQuery(c.req.valid("query"));
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, 400);
      }
      if (!deps.memory.feed) {
        return c.json({ error: "feed requires the engine DocumentStore" }, 501);
      }
      try {
        const result = await deps.memory.feed({
          tenantId: scopeId,
          principalId: subjectId,
          ...parsed.value,
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof MemoryError) {
          return c.json(
            { error: err.message },
            err.status as 400 | 501,
          );
        }
        const errMessage = formatCaughtError(err);
        log.error(`memory feed failed: ${errMessage}`, {
          error: errMessage,
        });
        return c.json({ error: "feed failed" }, 502);
      }
    },
  );
}
