/**
 * CL-5233: all engine tables live under the knowledge Postgres schema.
 */
import { describe, expect, it } from "bun:test";
import { getTableName } from "drizzle-orm";
import {
  KNOWLEDGE_SCHEMA,
  knowledgeChunk,
  knowledgeDocument,
  knowledgeEdge,
  knowledgeEmbedModel,
  knowledgeEntity,
  knowledgeSchema,
  knowledgeVersion,
  rawCapture,
  transformConfig,
  transformRun,
} from "./schema.ts";

const TABLES = [
  knowledgeDocument,
  knowledgeVersion,
  knowledgeChunk,
  knowledgeEntity,
  knowledgeEdge,
  rawCapture,
  knowledgeEmbedModel,
  transformConfig,
  transformRun,
] as const;

describe("knowledge Postgres schema qualification (CL-5233)", () => {
  it("exports KNOWLEDGE_SCHEMA = knowledge", () => {
    expect(KNOWLEDGE_SCHEMA).toBe("knowledge");
    expect(knowledgeSchema.schemaName).toBe("knowledge");
  });

  it("every table is registered under the knowledge schema", () => {
    for (const table of TABLES) {
      // drizzle Table internal schema key
      const schemaName = (table as unknown as { [key: symbol]: unknown })[
        Symbol.for("drizzle:Schema")
      ];
      expect(schemaName).toBe("knowledge");
      // bare names drop the redundant knowledge_ prefix
      expect(getTableName(table)).not.toMatch(/^knowledge_/);
    }
  });

  it("maps legacy knowledge_* names to short table names", () => {
    expect(getTableName(knowledgeDocument)).toBe("document");
    expect(getTableName(knowledgeVersion)).toBe("version");
    expect(getTableName(knowledgeChunk)).toBe("chunk");
    expect(getTableName(knowledgeEntity)).toBe("entity");
    expect(getTableName(knowledgeEdge)).toBe("edge");
    expect(getTableName(knowledgeEmbedModel)).toBe("embed_model");
    expect(getTableName(rawCapture)).toBe("raw_capture");
    expect(getTableName(transformConfig)).toBe("transform_config");
    expect(getTableName(transformRun)).toBe("transform_run");
  });
});
