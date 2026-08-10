import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EDGE_RELS,
  EDGE_REF_TYPES_DB,
  LINEAGE_CLASSES,
  PROVENANCE_MODES,
  TEMPORAL_CLASSES,
} from "./enums.ts";
import { MemoryEdgeRelSchema, MemoryEdgeRefTypeSchema } from "./schemas/entity-edge.ts";
import {
  LineageClassSchema,
  ProvenanceModeSchema,
  TemporalClassSchema,
} from "./schemas/document.ts";
import { type } from "arktype";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

function allMigrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");
}

/** Pull the last CHECK (... IN (...)) body for a named constraint. */
function lastCheckInList(sql: string, constraintName: string): string[] {
  const re = new RegExp(
    `CONSTRAINT\\s+"${constraintName}"\\s+CHECK\\s*\\(\\s*"[^"]+"\\s+IN\\s*\\(([\\s\\S]*?)\\)\\s*\\)`,
    "gi",
  );
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(sql)) !== null) {
    last = match[1] ?? null;
  }
  if (last === null) {
    throw new Error(`constraint ${constraintName} not found in migrations`);
  }
  return [...last.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("enum lockstep: TS constants match migration CHECK constraints", () => {
  const sql = allMigrationSql();

  it("edge_rel_check matches EDGE_RELS", () => {
    expect(sorted(lastCheckInList(sql, "edge_rel_check"))).toEqual(
      sorted(EDGE_RELS),
    );
  });

  it("edge_from_type_check matches EDGE_REF_TYPES_DB", () => {
    expect(sorted(lastCheckInList(sql, "edge_from_type_check"))).toEqual(
      sorted(EDGE_REF_TYPES_DB),
    );
  });

  it("edge_to_type_check matches EDGE_REF_TYPES_DB", () => {
    expect(sorted(lastCheckInList(sql, "edge_to_type_check"))).toEqual(
      sorted(EDGE_REF_TYPES_DB),
    );
  });

  it("version_source_class_check matches LINEAGE_CLASSES", () => {
    expect(sorted(lastCheckInList(sql, "version_source_class_check"))).toEqual(
      sorted(LINEAGE_CLASSES),
    );
  });

  it("version_provenance_check matches PROVENANCE_MODES", () => {
    expect(sorted(lastCheckInList(sql, "version_provenance_check"))).toEqual(
      sorted(PROVENANCE_MODES),
    );
  });

  it("version_temporal_class_check matches TEMPORAL_CLASSES", () => {
    expect(sorted(lastCheckInList(sql, "version_temporal_class_check"))).toEqual(
      sorted(TEMPORAL_CLASSES),
    );
  });
});

describe("enum lockstep: arktype accepts every SSOT value and rejects unknown", () => {
  it("MemoryEdgeRelSchema accepts all EDGE_RELS", () => {
    for (const rel of EDGE_RELS) {
      const out = MemoryEdgeRelSchema(rel);
      expect(out instanceof type.errors ? out.summary : out).toBe(rel);
    }
    expect(MemoryEdgeRelSchema("produced_by") instanceof type.errors).toBe(
      true,
    );
  });

  it("MemoryEdgeRefTypeSchema accepts adapter set including native", () => {
    for (const t of ["document", "version", "chunk", "entity", "native"] as const) {
      const out = MemoryEdgeRefTypeSchema(t);
      expect(out instanceof type.errors ? out.summary : out).toBe(t);
    }
  });

  it("LineageClassSchema accepts LINEAGE_CLASSES only", () => {
    for (const c of LINEAGE_CLASSES) {
      expect(LineageClassSchema(c) instanceof type.errors).toBe(false);
    }
    expect(LineageClassSchema("thread") instanceof type.errors).toBe(true);
  });

  it("ProvenanceModeSchema accepts PROVENANCE_MODES only", () => {
    for (const p of PROVENANCE_MODES) {
      expect(ProvenanceModeSchema(p) instanceof type.errors).toBe(false);
    }
    expect(ProvenanceModeSchema("guessed") instanceof type.errors).toBe(true);
  });

  it("TemporalClassSchema accepts TEMPORAL_CLASSES only", () => {
    for (const t of TEMPORAL_CLASSES) {
      expect(TemporalClassSchema(t) instanceof type.errors).toBe(false);
    }
    expect(TemporalClassSchema("forecast") instanceof type.errors).toBe(true);
  });
});
