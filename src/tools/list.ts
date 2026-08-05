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
  type MemoryToolEnv,
} from "./client.ts";

type ListEnv = BaseEnv & MemoryToolEnv;

function asOptionalLimit(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 100) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  return v;
}

/**
 * Installable tool: GET /api/tenants/:tenantId/memory/list.
 *
 * Tenant and auth come from env; model args never carry identity.
 */
export const memoryList = defineTool<ListEnv>({
  id: "@corbits/memory/list",
  requires: MEMORY_TOOL_ENV_KEYS,
  factory(env) {
    const client = createMemoryHttpClient(readMemoryToolEnv(env));
    const runner = createToolRunner([
      stringTool({
        definition: {
          name: "memory_list",
          description:
            "List recent documents visible to the authenticated principal " +
            "in this tenant's memory.",
          inputSchema: {
            type: "object",
            properties: {
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                description: "Max events to return (1–100)",
              },
            },
            additionalProperties: false,
          },
        },
        handler: async (args, signal) => {
          const limit = asOptionalLimit(args["limit"]);
          const result = await client.list(limit, signal);
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
