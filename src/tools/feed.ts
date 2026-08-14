import { type } from "arktype";

import { parseWithArk } from "../http-bodies.ts";
import { defineMemoryHttpTool } from "./install.ts";

const FeedArgs = type({
  "after?": "number.integer >= 0",
  "limit?": "1 <= number.integer <= 100",
  "exclude_generator?": "string",
});

function coerceFeedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const key of ["after", "limit"] as const) {
    const raw = out[key];
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) out[key] = n;
    }
  }
  return out;
}

/**
 * Installable tool: GET /api/tenants/:tenantId/memory/feed.
 *
 * Distiller pull surface — always pass exclude_generator matching the
 * writer's generator_agent_id so the agent never re-consumes its own claims.
 */
export const memoryFeed = defineMemoryHttpTool({
  id: "@corbits/memory/feed",
  name: "memory_feed",
  description:
    "Pull new memory versions after a cursor (capture feed). " +
    "Returns { entries, nextCursor }. Always set exclude_generator to your " +
    "generator_agent_id (e.g. resident-distiller) for loop-safety. " +
    "Copy accessTags from each entry onto distilled writes — never widen.",
  inputSchema: {
    type: "object",
    properties: {
      after: {
        type: "integer",
        minimum: 0,
        description: "Exclusive cursor (feed_seq > after). Default 0.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Page size (1–100, default 50)",
      },
      exclude_generator: {
        type: "string",
        description:
          "Skip versions written by this generator_agent_id (loop-safety)",
      },
    },
    additionalProperties: false,
  },
  async handle(client, args, signal) {
    const parsed = parseWithArk(
      FeedArgs,
      coerceFeedArgs(args),
      "memory_feed",
    );
    const result = await client.feed(
      {
        ...(parsed.after !== undefined ? { after: parsed.after } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        ...(parsed.exclude_generator !== undefined
          ? { excludeGenerator: parsed.exclude_generator }
          : {}),
      },
      signal,
    );
    return JSON.stringify(result);
  },
});
