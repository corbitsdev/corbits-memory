import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EDGE_RELS,
  EDGE_REF_TYPES_DB,
  LINEAGE_CLASSES,
  PROVENANCE_MODES,
  RETENTION_CLASSES,
  TEMPORAL_CLASSES,
} from "./enums.js";

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

  it.each([
    ["edge_rel_check", EDGE_RELS],
    ["edge_from_type_check", EDGE_REF_TYPES_DB],
    ["edge_to_type_check", EDGE_REF_TYPES_DB],
    ["version_source_class_check", LINEAGE_CLASSES],
    ["version_provenance_check", PROVENANCE_MODES],
    ["version_temporal_class_check", TEMPORAL_CLASSES],
    ["version_retention_class_check", RETENTION_CLASSES],
  ] as const)("%s matches its SSOT constant", (constraint, values) => {
    expect(sorted(lastCheckInList(sql, constraint))).toEqual(sorted(values));
  });
});
