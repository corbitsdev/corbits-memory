import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import { KnowledgeError } from "../knowledge.ts";
import { SearchResponseSchema } from "../core/schemas/search.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

// `kinds`/`entity_ids` scope the LEXICAL retrieval leg only — the dense
// channel has no equivalent predicate, so fused results can still include a
// hit that reached the result purely via semantic similarity and does not
// match the requested kind/entity. See the `kinds`/`entityIds` doc comments
// on KnowledgeSearchParams (knowledge.ts) for the full explanation.
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

export function mountSearchRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/knowledge/search",
    describeRoute({
      tags: ["knowledge"],
      summary: "Hybrid semantic + keyword search",
      description:
        "`kinds`/`entity_ids` scope the lexical (keyword) retrieval leg " +
        "only; the dense/semantic leg has no such predicate, so a hit " +
        "surfaced purely by semantic similarity can appear in results " +
        "without matching the requested kind or entity. Treat these as a " +
        "relevance hint, not an exact post-fusion filter.",
      responses: {
        200: {
          description: "Ranked hits with evidence",
          content: {
            "application/json": { schema: resolver(SearchResponseSchema) },
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
        const result = await deps.knowledge.search({
          query,
          tenantId: scopeId,
          principalId: subjectId,
          ...(k !== undefined ? { k } : {}),
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
