import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORY_GRANT_REQUIREMENTS } from "./grant-requirements.ts";

describe("MEMORY_GRANT_REQUIREMENTS", () => {
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
