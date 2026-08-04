import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import { MemoryError } from "../memory.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

// `kinds`/`entity_ids` scope every retrieval channel — see the
// `kinds`/`entityIds` doc comments on MemoryFindParams (memory.ts)
// for the full explanation.
//
// An empty array on either field is equivalent to omitting it — "no filter"
// — not "match nothing", and does not satisfy the requirement that an empty
// `query` be paired with a non-empty structured filter.
const FindRequest = type({
  query: "string >= 1",
  "limit?": "1 <= number.integer <= 50",
  "kinds?": "string[]",
  "entity_ids?": "string[]",
  "sources?": "string[]",
  "includeEvidence?": "boolean",
});

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

export function mountFindRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/memory/find",
    describeRoute({
      tags: ["memory"],
      summary: "Hybrid semantic + keyword find",
      description:
        "`kinds`/`entity_ids` scope every retrieval channel (lexical and " +
        "dense) before results are fused, so every hit matches the " +
        "requested kind/entity. `sources` optionally restricts local + live " +
        "channels; `includeEvidence` defaults true on the wire.",
      responses: {
        200: {
          description: "Ranked items with evidence",
          content: {
            "application/json": { schema: resolver(FindResponse) },
          },
        },
        400: { description: "Invalid query" },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the memory:find grant" },
        502: { description: "find failed" },
      },
    }),
    requirePrincipal(),
    grantGuard(deps, "find"),
    validator("json", FindRequest),
    async (c) => {
      const { query, limit, kinds, entity_ids, sources, includeEvidence } =
        c.req.valid("json");
      const { scopeId, subjectId } = caller(c);
      try {
        const result = await deps.memory.find({
          query,
          tenantId: scopeId,
          principalId: subjectId,
          // Default true on HTTP so the wire always reports evidence unless
          // the client explicitly opts out.
          includeEvidence: includeEvidence ?? true,
          ...(limit !== undefined ? { limit } : {}),
          ...(kinds !== undefined ? { kinds } : {}),
          ...(entity_ids !== undefined ? { entityIds: entity_ids } : {}),
          ...(sources !== undefined ? { sources } : {}),
        });
        return c.json(result);
      } catch (err) {
        const errMessage = formatCaughtError(err);
        log.error(`memory find failed: ${errMessage}`, { err });
        if (err instanceof MemoryError) {
          return c.json({ error: err.message }, err.status as 400);
        }
        return c.json({ error: "find failed" }, 502);
      }
    },
  );
}
