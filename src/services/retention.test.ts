import { describe, expect, it } from "bun:test";

// Pure policy helpers exercised via types + export surface.
// DB mutation tests need a real postgres; unit coverage is the lockstep
// enum + this smoke import.

import {
  deprecateVersion,
  hardDeleteDocument,
  setRetentionClass,
  sweepEphemeral,
  tombstoneDocument,
} from "./retention.ts";

describe("retention exports", () => {
  it("exposes the CL-5871 write verbs", () => {
    expect(typeof deprecateVersion).toBe("function");
    expect(typeof tombstoneDocument).toBe("function");
    expect(typeof hardDeleteDocument).toBe("function");
    expect(typeof sweepEphemeral).toBe("function");
    expect(typeof setRetentionClass).toBe("function");
  });
});
