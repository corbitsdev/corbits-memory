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
  type MemoryAddBody,
  type MemoryToolEnv,
} from "./client.ts";

type AddEnv = BaseEnv & MemoryToolEnv;

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

function parseAddArgs(args: Record<string, unknown>): MemoryAddBody {
  const title = asString(args["title"], "title");
  const text = asString(args["text"], "text");
  const access_tags = asOptionalStringArray(args["access_tags"], "access_tags");

  let share: MemoryAddBody["share"];
  const rawShare = args["share"];
  if (rawShare !== undefined) {
    if (rawShare === null || typeof rawShare !== "object" || Array.isArray(rawShare)) {
      throw new Error("share must be an object");
    }
    const s = rawShare as Record<string, unknown>;
    const tenant = s["tenant"];
    if (tenant !== undefined && typeof tenant !== "boolean") {
      throw new Error("share.tenant must be a boolean");
    }
    const principals = asOptionalStringArray(s["principals"], "share.principals");
    const tags = asOptionalStringArray(s["tags"], "share.tags");
    share = {
      ...(tenant !== undefined ? { tenant } : {}),
      ...(principals !== undefined ? { principals } : {}),
      ...(tags !== undefined ? { tags } : {}),
    };
  }

  return {
    title,
    text,
    ...(access_tags !== undefined ? { access_tags } : {}),
    ...(share !== undefined ? { share } : {}),
  };
}

/**
 * Installable tool: POST /api/tenants/:tenantId/memory/add.
 *
 * Tenant and auth come from env (`memoryTenantId`, `memoryAuthToken`);
 * model args never carry identity.
 */
export const memoryAdd = defineTool<AddEnv>({
  id: "@corbits/memory/add",
  requires: MEMORY_TOOL_ENV_KEYS,
  factory(env) {
    const client = createMemoryHttpClient(readMemoryToolEnv(env));
    const runner = createToolRunner([
      stringTool({
        definition: {
          name: "memory_add",
          description:
            "Store a note in tenant memory. Returns { documentId }. " +
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
        },
        handler: async (args, signal) => {
          const body = parseAddArgs(args);
          const result = await client.add(body, signal);
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
