import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import { KnowledgeError } from "../knowledge.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

// `kinds`/`entity_ids` scope every retrieval channel — see the
// `kinds`/`entityIds` doc comments on KnowledgeSearchParams (knowledge.ts)
// for the full explanation.
//
// An empty array on either field is equivalent to omitting it — "no filter"
// — not "match nothing", and does not satisfy the requirement that an empty
// `query` be paired with a non-empty structured filter.
const SearchRequest = type({
  query: "string >= 1",
  "k?": "1 <= number.integer <= 50",
  "kinds?": "string[]",
  "entity_ids?": "string[]",
});

// Green FindResult shape. includeEvidence is always true on HTTP so the wire
// keeps reporting evidence for existing clients.
const FindResponse = type({
  items: type({
    documentId: "string",
    title: "string",
    snippet: "string",
    score: "number",
    kind: "string",
    citation: "unknown",
  }).array(),
  "evidence?": "'strong'|'weak'|'none'",
  "degraded?": "string[]",
});

export function mountSearchRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/knowledge/search",
    describeRoute({
      tags: ["knowledge"],
      summary: "Hybrid semantic + keyword search",
      description:
        "`kinds`/`entity_ids` scope every retrieval channel (lexical and " +
        "dense) before results are fused, so every hit matches the " +
        "requested kind/entity.",
      responses: {
        200: {
          description: "Ranked items with evidence",
          content: {
            "application/json": { schema: resolver(FindResponse) },
          },
        },
        400: { description: "Invalid query" },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the knowledge:search grant" },
      },
    }),
    requirePrincipal(),
    grantGuard(deps, "search"),
    validator("json", SearchRequest),
    async (c) => {
      const { query, k, kinds, entity_ids } = c.req.valid("json");
      const { scopeId, subjectId } = caller(c);
      try {
// Body still accepts k — map to green limit. Always includeEvidence so
        // the wire keeps the evidence field clients already rely on.
        const result = await deps.knowledge.find({
          query,
          tenantId: scopeId,
          principalId: subjectId,
          includeEvidence: true,
          ...(k !== undefined ? { limit: k } : {}),
          ...(kinds !== undefined ? { kinds } : {}),
          ...(entity_ids !== undefined ? { entityIds: entity_ids } : {}),
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
