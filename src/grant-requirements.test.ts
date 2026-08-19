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

  test("add/search are tenant-sourced and reach tools + distiller + routes", () => {
    for (const action of ["add", "search"]) {
      const r = MEMORY_GRANT_REQUIREMENTS.find((x) => x.action === action)!;
      expect(r.source).toBe("tenant");
      expect(r.surfaces).toContain("tools");
      expect(r.surfaces).toContain("distiller");
      expect(r.surfaces).toContain("routes");
    }
  });

  test("forget/purge are creator-sourced and routes-only", () => {
    for (const action of ["forget", "purge"]) {
      const r = MEMORY_GRANT_REQUIREMENTS.find((x) => x.action === action)!;
      expect(r.source).toBe("creator");
      expect(r.surfaces).toEqual(["routes"]);
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
          source: string;
          surfaces: string[];
        }>;
      };
    };
    const fromPkg = pkg.interchange?.grantRequirements ?? [];
    expect(fromPkg).toEqual(
      MEMORY_GRANT_REQUIREMENTS.map((r) => ({
        resource: r.resource,
        action: r.action,
        source: r.source,
        surfaces: [...r.surfaces],
      })),
    );
  });
});
