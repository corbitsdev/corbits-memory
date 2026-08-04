import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import {
  MemoryError,
  MemoryNotPermittedError,
} from "../memory.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

const AskRequest = type({
  query: "string >= 1",
  "limit?": "1 <= number.integer <= 50",
  "sources?": "string[]",
  "includeMemory?": "boolean",
});

const AskResponse = type({
  text: "string",
  citations: type({
    index: "number",
    documentId: "string",
    title: "string",
    citation: "unknown",
  }).array(),
  evidence: "'strong'|'weak'|'none'",
  "degraded?": "string[]",
});

export function mountAskRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/memory/ask",
    describeRoute({
      tags: ["memory"],
      summary: "Answer a question from retrieved memory",
      responses: {
        200: {
          description: "Grounded answer with citations",
          content: {
            "application/json": { schema: resolver(AskResponse) },
          },
        },
        400: { description: "Invalid query" },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the memory:find grant" },
        501: { description: "ask is not configured (no generate)" },
        502: { description: "ask failed" },
      },
    }),
    requirePrincipal(),
    // Same capability as find — ask retrieves as the principal then synthesizes.
    grantGuard(deps, "find"),
    validator("json", AskRequest),
    async (c) => {
      const { query, limit, sources, includeMemory } = c.req.valid("json");
      const { scopeId, subjectId } = caller(c);
      try {
        const result = await deps.memory.ask({
          query,
          tenantId: scopeId,
          principalId: subjectId,
          ...(limit !== undefined ? { limit } : {}),
          ...(sources !== undefined ? { sources } : {}),
          ...(includeMemory !== undefined ? { includeMemory } : {}),
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof MemoryNotPermittedError) {
          return c.json({ error: err.message }, 403);
        }
        if (err instanceof MemoryError) {
          return c.json(
            { error: err.message },
            err.status as 400 | 501,
          );
        }
        const errMessage = formatCaughtError(err);
        log.error(`memory ask failed: ${errMessage}`, { err });
        return c.json({ error: "ask failed" }, 502);
      }
    },
  );
}
