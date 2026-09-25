/**
 * Tool descriptors for hosts that register memory behaviors with an agent
 * runtime. Structural, not imported from a runtime package: this module
 * stays free of any agent-SDK dependency, and `sidecar-bundle.ts` binds each
 * name to the run-scoped route that performs it.
 */
import { LIST_LIMIT_MAX, LIST_LIMIT_MIN, SEARCH_LIMIT_MAX, SEARCH_LIMIT_MIN } from "./limits.js";

export type MemoryToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
};

export const MEMORY_TOOL_DEFINITIONS: readonly MemoryToolDefinition[] = [
  {
    name: "memory_add",
    description:
      "Store a note in workbench memory. Every note you store is shared with " +
      "your workbench team automatically — do not pass share. Returns " +
      "{ documentId, versionId }. For distilled claims set generator_agent_id, " +
      "provenance=inferred, lineage_class=derived, and derived_from source " +
      "version ids. Identity is the run this agent is acting for.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the document" },
        text: { type: "string", description: "Full body text to store" },
        access_tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional grant-pattern tags controlling document visibility " +
            "(distiller: copy from source feed entry, never widen)",
        },
        kind: { type: "string", description: "Document kind (default note)" },
        generator_agent_id: {
          type: "string",
          description:
            "Agent id that authored this version (e.g. resident-distiller). " +
            "Enables feed exclude_generator loop-safety.",
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
        valid_from: { type: "string", description: "Optional validity start (ISO)" },
        valid_until: { type: "string", description: "Optional validity end (ISO)" },
        share: {
          type: "object",
          properties: {
            tenant: { type: "boolean" },
            principals: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
          },
          description:
            "Rarely needed: team sharing is already on. Only widens further " +
            "(named principals / extra tags); it can never narrow.",
        },
      },
      required: ["title", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description:
      "Hybrid semantic + keyword search over your workbench's memory, " +
      "including memories your teammates' agents stored. " +
      "Returns ranked items with optional additive attribution " +
      "(provenance, temporal class, corroboration, derivedFrom) and evidence. " +
      "Attribute stated content to the actor; treat inferred as own-voice claims.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
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
          description: 'Optional channel filter (e.g. "local" and/or live source ids)',
        },
        includeEvidence: {
          type: "boolean",
          description: "Include evidence strength on the response",
        },
        includeDeprecated: {
          type: "boolean",
          description: "Include deprecated versions in results (default false)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_list",
    description: "List recent documents in your workbench's memory, including your teammates'.",
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
  },
  {
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
          description: "Skip versions written by this generator_agent_id (loop-safety)",
        },
      },
      additionalProperties: false,
    },
  },
];
