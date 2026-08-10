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
  if (parsed.kind !== undefined) {
    body.kind = parsed.kind;
  }
  if (parsed.generator_agent_id !== undefined) {
    body.generator_agent_id = parsed.generator_agent_id;
  }
  if (parsed.provenance !== undefined) {
    body.provenance = parsed.provenance;
  }
  if (parsed.lineage_class !== undefined) {
    body.lineage_class = parsed.lineage_class;
  }
  if (parsed.temporal_class !== undefined) {
    body.temporal_class = parsed.temporal_class;
  }
  if (parsed.derived_from !== undefined) {
    body.derived_from = parsed.derived_from;
  }
  if (parsed.valid_from !== undefined) {
    body.valid_from = parsed.valid_from;
  }
  if (parsed.valid_until !== undefined) {
    body.valid_until = parsed.valid_until;
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
 * model args never carry identity. Distiller claims pass
 * `generator_agent_id` + `derived_from` for loop-safety and lineage.
 */
export const memoryAdd = defineMemoryHttpTool({
  id: "@corbits/memory/add",
  name: "memory_add",
  description:
    "Store a note in tenant memory. Returns { documentId, versionId }. " +
    "For distilled claims set generator_agent_id, provenance=inferred, " +
    "lineage_class=derived, and derived_from source version ids. " +
    "Identity is the authenticated principal on the hub.",
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
          "Optional grant-pattern tags controlling document visibility " +
          "(distiller: copy from source feed entry, never widen)",
      },
      kind: {
        type: "string",
        description: "Document kind (default note)",
      },
      generator_agent_id: {
        type: "string",
        description:
          "Agent id that authored this version (e.g. resident-distiller). " +
          "Enables feed excludeGenerator loop-safety.",
      },
      provenance: {
        type: "string",
        enum: ["stated", "inferred", "unknown"],
        description: "How content was obtained (inferred for distilled claims)",
      },
      lineage_class: {
        type: "string",
        enum: ["native", "imported", "derived"],
        description: "Data lineage (derived for distilled claims)",
      },
      temporal_class: {
        type: "string",
        enum: ["event", "deadline", "state", "lesson"],
        description: "Temporal ranking class",
      },
      derived_from: {
        type: "array",
        items: { type: "string" },
        description: "Source version ids this claim is derived from",
      },
      valid_from: {
        type: "string",
        description: "Optional validity start (ISO)",
      },
      valid_until: {
        type: "string",
        description: "Optional validity end (ISO)",
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
