import { AddRequest, parseWithArk } from "../http-bodies.ts";
import type { MemoryAddBody } from "./client.ts";
import { defineMemoryHttpTool } from "./install.ts";

function parseAddArgs(args: Record<string, unknown>): MemoryAddBody {
  const parsed = parseWithArk(AddRequest, args, "memory_add");
  // Forward only schema fields so identity keys never ride the wire.
  const body: MemoryAddBody = {
    title: parsed.title,
    text: parsed.text,
  };
  if (parsed.access_tags !== undefined) {
    body.access_tags = parsed.access_tags;
  }
  if (parsed.share !== undefined) {
    // Rebuild share field-by-field — arktype keeps undeclared nested keys.
    const share: NonNullable<MemoryAddBody["share"]> = {};
    if (parsed.share.tenant !== undefined) {
      share.tenant = parsed.share.tenant;
    }
    if (parsed.share.principals !== undefined) {
      share.principals = parsed.share.principals;
    }
    if (parsed.share.tags !== undefined) {
      share.tags = parsed.share.tags;
    }
    body.share = share;
  }
  return body;
}

/**
 * Installable tool: POST /api/tenants/:tenantId/memory/add.
 *
 * Tenant and auth come from env (`memoryTenantId`, `memoryAuthToken`);
 * model args never carry identity.
 */
export const memoryAdd = defineMemoryHttpTool({
  id: "@corbits/memory/add",
  name: "memory_add",
  description:
    "Store a note in tenant memory. Returns { documentId, versionId }. " +
    "Identity is the authenticated principal on the hub; do not " +
    "pass tenant or principal ids.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short title for the document",
      },
      text: {
        type: "string",
        description: "Full body text to store",
      },
      access_tags: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional grant-pattern tags controlling document visibility",
      },
      share: {
        type: "object",
        properties: {
          tenant: { type: "boolean" },
          principals: {
            type: "array",
            items: { type: "string" },
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
        description:
          "Optional share sugar that mints access tags (tenant / principals / tags)",
      },
    },
    required: ["title", "text"],
    additionalProperties: false,
  },
  async handle(client, args, signal) {
    const body = parseAddArgs(args);
    const result = await client.add(body, signal);
    return JSON.stringify(result);
  },
});
