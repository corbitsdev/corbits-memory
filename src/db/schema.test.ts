/**
 * CL-5233: all engine tables live under the memory Postgres schema. Renamed from `knowledge` to `memory` for CL-6009.
 */
import { describe, expect, it } from "bun:test";
import { getTableName } from "drizzle-orm";
import {
  MEMORY_SCHEMA,
  memoryChunk,
  memoryDocument,
  memoryEdge,
  memoryEmbedModel,
  memoryEntity,
  memorySchema,
  memoryVersion,
  rawCapture,
  transformConfig,
  transformRun,
} from "./schema.ts";

const TABLES = [
  memoryDocument,
  memoryVersion,
  memoryChunk,
  memoryEntity,
  memoryEdge,
  rawCapture,
  memoryEmbedModel,
  transformConfig,
  transformRun,
] as const;

describe("memory Postgres schema qualification (CL-5233)", () => {
  it("exports MEMORY_SCHEMA = memory", () => {
    expect(MEMORY_SCHEMA).toBe("memory");
    expect(memorySchema.schemaName).toBe("memory");
  });

  it("every table is registered under the memory schema", () => {
    for (const table of TABLES) {
      // drizzle Table internal schema key
      const schemaName = (table as unknown as { [key: symbol]: unknown })[
        Symbol.for("drizzle:Schema")
      ];
      expect(schemaName).toBe("memory");
      // bare names drop the redundant memory_ prefix
      expect(getTableName(table)).not.toMatch(/^memory_/);
    }
  });

  it("maps legacy memory_* names to short table names", () => {
    expect(getTableName(memoryDocument)).toBe("document");
    expect(getTableName(memoryVersion)).toBe("version");
    expect(getTableName(memoryChunk)).toBe("chunk");
    expect(getTableName(memoryEntity)).toBe("entity");
    expect(getTableName(memoryEdge)).toBe("edge");
    expect(getTableName(memoryEmbedModel)).toBe("embed_model");
    expect(getTableName(rawCapture)).toBe("raw_capture");
    expect(getTableName(transformConfig)).toBe("transform_config");
    expect(getTableName(transformRun)).toBe("transform_run");
  });
});
