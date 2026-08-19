import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  capabilityIdsForSurface,
  MEMORY_CAPABILITY_IDS,
  MEMORY_GRANT_REQUIREMENTS,
} from "./grant-requirements.ts";

describe("MEMORY_GRANT_REQUIREMENTS", () => {
  test("covers add, search, forget, and purge on memory resource", () => {
    expect(MEMORY_GRANT_REQUIREMENTS.map((r) => r.action).sort()).toEqual([
      "add",
      "forget",
      "purge",
      "search",
    ]);
    for (const r of MEMORY_GRANT_REQUIREMENTS) {
      expect(r.resource).toBe("memory");
    }
  });

  test("add/search hint tenant-wide and reach tools + distiller + routes", () => {
    for (const action of ["add", "search"]) {
      const r = MEMORY_GRANT_REQUIREMENTS.find((x) => x.action === action)!;
      expect(r.installHint).toBe("tenant");
      expect(r.surfaces).toContain("tools");
      expect(r.surfaces).toContain("distiller");
      expect(r.surfaces).toContain("routes");
    }
  });

  test("forget/purge hint creator-scoped and are routes-only", () => {
    for (const action of ["forget", "purge"]) {
      const r = MEMORY_GRANT_REQUIREMENTS.find((x) => x.action === action)!;
      expect(r.installHint).toBe("creator");
      expect(r.surfaces).toEqual(["routes"]);
    }
  });

  test("installHint is advisory only — the requirement shape carries no enforcement field", () => {
    // The actual ownership check lives in services/retention-ownership.ts,
    // wired imperatively into memory.ts, entirely independent of this hint.
    // This test exists so a future reader who tightens grant-requirements.ts
    // notices this comment rather than assuming installHint is load-bearing.
    for (const r of MEMORY_GRANT_REQUIREMENTS) {
      expect(Object.keys(r).sort()).toEqual([
        "action",
        "installHint",
        "resource",
        "surfaces",
      ]);
    }
  });

  test("capability ids are resource:action", () => {
    expect([...MEMORY_CAPABILITY_IDS].sort()).toEqual([
      "memory:add",
      "memory:forget",
      "memory:purge",
      "memory:search",
    ]);
  });

  test("capabilityIdsForSurface excludes routes-only actions from distiller/tools", () => {
    expect(capabilityIdsForSurface("distiller").sort()).toEqual([
      "memory:add",
      "memory:search",
    ]);
    expect(capabilityIdsForSurface("tools").sort()).toEqual([
      "memory:add",
      "memory:search",
    ]);
    expect(capabilityIdsForSurface("routes").sort()).toEqual([
      "memory:add",
      "memory:forget",
      "memory:purge",
      "memory:search",
    ]);
  });

  test("package.json interchange.grantRequirements stays in lockstep", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as {
      interchange?: {
        grantRequirements?: Array<{
          resource: string;
          action: string;
          installHint: string;
          surfaces: string[];
        }>;
      };
    };
    const fromPkg = pkg.interchange?.grantRequirements ?? [];
    expect(fromPkg).toEqual(
      MEMORY_GRANT_REQUIREMENTS.map((r) => ({
        resource: r.resource,
        action: r.action,
        installHint: r.installHint,
        surfaces: [...r.surfaces],
      })),
    );
  });
});
