import {
  coerceOptionalLimitArg,
  ListArgs,
  parseWithArk,
} from "../http-bodies.ts";
import { LIST_LIMIT_MAX, LIST_LIMIT_MIN } from "../limits.ts";
import { defineMemoryHttpTool } from "./install.ts";

function parseListLimit(args: Record<string, unknown>): number | undefined {
  const parsed = parseWithArk(
    ListArgs,
    coerceOptionalLimitArg(args),
    "memory_list",
  );
  return parsed.limit;
}

/**
 * Installable tool: GET /api/tenants/:tenantId/memory/list.
 *
 * Tenant and auth come from env; model args never carry identity.
 */
export const memoryList = defineMemoryHttpTool({
  id: "@corbits/memory/list",
  name: "memory_list",
  description:
    "List recent documents visible to the authenticated principal " +
    "in this tenant's memory.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: LIST_LIMIT_MIN,
        maximum: LIST_LIMIT_MAX,
        description: `Max events to return (${LIST_LIMIT_MIN}–${LIST_LIMIT_MAX})`,
      },
    },
    additionalProperties: false,
  },
  async handle(client, args, signal) {
    const limit = parseListLimit(args);
    const result = await client.list(limit, signal);
    return JSON.stringify(result);
  },
});
