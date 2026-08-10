import {
  coerceOptionalLimitArg,
  parseWithArk,
  SearchRequest,
} from "../http-bodies.ts";
import { SEARCH_LIMIT_MAX, SEARCH_LIMIT_MIN } from "../limits.ts";
import type { MemorySearchBody } from "./client.ts";
import { defineMemoryHttpTool } from "./install.ts";

function parseSearchArgs(args: Record<string, unknown>): MemorySearchBody {
  const parsed = parseWithArk(
    SearchRequest,
    coerceOptionalLimitArg(args),
    "memory_search",
  );
  const body: MemorySearchBody = { query: parsed.query };
  if (parsed.limit !== undefined) body.limit = parsed.limit;
  if (parsed.kinds !== undefined) body.kinds = parsed.kinds;
  if (parsed.entity_ids !== undefined) body.entity_ids = parsed.entity_ids;
  if (parsed.sources !== undefined) body.sources = parsed.sources;
  if (parsed.includeEvidence !== undefined) {
    body.includeEvidence = parsed.includeEvidence;
  }
  if (parsed.includeDeprecated !== undefined) {
    body.includeDeprecated = parsed.includeDeprecated;
  }
  return body;
}

/**
 * Installable tool: POST /api/tenants/:tenantId/memory/search.
 *
 * Tenant and auth come from env; model args never carry identity.
 */
export const memorySearch = defineMemoryHttpTool({
  id: "@corbits/memory/search",
  name: "memory_search",
  description:
    "Hybrid semantic + keyword search over tenant memory. " +
    "Returns ranked items (and optional evidence). Identity is " +
    "the authenticated principal on the hub.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query text",
      },
      limit: {
        type: "integer",
        minimum: SEARCH_LIMIT_MIN,
        maximum: SEARCH_LIMIT_MAX,
        description: `Max hits to return (${SEARCH_LIMIT_MIN}–${SEARCH_LIMIT_MAX})`,
      },
      kinds: {
        type: "array",
        items: { type: "string" },
        description: "Optional document kind filter",
      },
      entity_ids: {
        type: "array",
        items: { type: "string" },
        description: "Optional entity-id filter",
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description:
          'Optional channel filter (e.g. "local" and/or live source ids)',
      },
      includeEvidence: {
        type: "boolean",
        description:
          "Include evidence strength on the response (hub default true)",
      },
      includeDeprecated: {
        type: "boolean",
        description:
          "Include deprecated versions in results (default false)",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handle(client, args, signal) {
    const body = parseSearchArgs(args);
    const result = await client.search(body, signal);
    return JSON.stringify(result);
  },
});
