import {
  createToolRunner,
  defineTool,
  stringTool,
  type BaseEnv,
} from "@intx/agent";

import {
  createMemoryHttpClient,
  MEMORY_TOOL_ENV_KEYS,
  readMemoryToolEnv,
  type MemorySearchBody,
  type MemoryToolEnv,
} from "./client.ts";

type SearchEnv = BaseEnv & MemoryToolEnv;

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return v;
}

function asOptionalStringArray(
  v: unknown,
  field: string,
): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return v;
}

function asOptionalLimit(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 50) {
    throw new Error("limit must be an integer from 1 to 50");
  }
  return v;
}

function parseSearchArgs(args: Record<string, unknown>): MemorySearchBody {
  const query = asString(args["query"], "query");
  const limit = asOptionalLimit(args["limit"]);
  const kinds = asOptionalStringArray(args["kinds"], "kinds");
  const entity_ids = asOptionalStringArray(args["entity_ids"], "entity_ids");
  const sources = asOptionalStringArray(args["sources"], "sources");
  const includeEvidence = args["includeEvidence"];
  if (includeEvidence !== undefined && typeof includeEvidence !== "boolean") {
    throw new Error("includeEvidence must be a boolean");
  }

  return {
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
    ...(entity_ids !== undefined ? { entity_ids } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(typeof includeEvidence === "boolean"
      ? { includeEvidence }
      : {}),
  };
}

/**
 * Installable tool: POST /api/tenants/:tenantId/memory/search.
 *
 * Tenant and auth come from env; model args never carry identity.
 */
export const memorySearch = defineTool<SearchEnv>({
  id: "@corbits/memory/search",
  requires: MEMORY_TOOL_ENV_KEYS,
  factory(env) {
    const client = createMemoryHttpClient(readMemoryToolEnv(env));
    const runner = createToolRunner([
      stringTool({
        definition: {
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
                minimum: 1,
                maximum: 50,
                description: "Max hits to return (1–50)",
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
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        handler: async (args, signal) => {
          const body = parseSearchArgs(args);
          const result = await client.search(body, signal);
          return JSON.stringify(result);
        },
      }),
    ]);
    return {
      definitions: runner.definitions,
      run: (call, signal) => runner.run(call, signal),
    };
  },
});
