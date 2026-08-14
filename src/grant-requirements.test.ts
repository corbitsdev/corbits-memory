import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MEMORY_CAPABILITY_IDS,
  MEMORY_GRANT_REQUIREMENTS,
} from "./grant-requirements.ts";

describe("MEMORY_GRANT_REQUIREMENTS", () => {
  test("covers add + search on memory resource", () => {
    expect(MEMORY_GRANT_REQUIREMENTS.map((r) => r.action).sort()).toEqual([
      "add",
      "search",
    ]);
    for (const r of MEMORY_GRANT_REQUIREMENTS) {
      expect(r.resource).toBe("memory");
      expect(r.source).toBe("tenant");
      expect(r.surfaces).toContain("tools");
      expect(r.surfaces).toContain("distiller");
    }
  });

  test("capability ids are resource:action", () => {
    expect([...MEMORY_CAPABILITY_IDS].sort()).toEqual([
      "memory:add",
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
