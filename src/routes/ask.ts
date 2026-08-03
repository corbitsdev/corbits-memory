import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import {
  KnowledgeError,
  KnowledgeNotPermittedError,
} from "../knowledge.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

const AskRequest = type({
  query: "string >= 1",
  "limit?": "1 <= number.integer <= 50",
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
});

export function mountAskRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/knowledge/ask",
    describeRoute({
      tags: ["knowledge"],
      summary: "Answer a question from retrieved knowledge",
      responses: {
        200: {
          description: "Grounded answer with citations",
          content: {
            "application/json": { schema: resolver(AskResponse) },
          },
        },
        400: { description: "Invalid query" },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the knowledge:find grant" },
        501: { description: "ask is not configured (no generate)" },
        502: { description: "ask failed" },
      },
    }),
    requirePrincipal(),
    // Same capability as find — ask retrieves as the principal then synthesizes.
    grantGuard(deps, "find"),
    validator("json", AskRequest),
    async (c) => {
      const { query, limit } = c.req.valid("json");
      const { scopeId, subjectId } = caller(c);
      try {
        const result = await deps.knowledge.ask({
          query,
          tenantId: scopeId,
          principalId: subjectId,
          ...(limit !== undefined ? { limit } : {}),
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof KnowledgeNotPermittedError) {
          return c.json({ error: err.message }, 403);
        }
        if (err instanceof KnowledgeError) {
          return c.json(
            { error: err.message },
            err.status as 400 | 501,
          );
        }
        const errMessage = formatCaughtError(err);
        log.error(`knowledge ask failed: ${errMessage}`, { err });
        return c.json({ error: "ask failed" }, 502);
      }
    },
  );
}
