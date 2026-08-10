import { describe, expect, it } from "bun:test";

import {
  buildDistilledClaim,
  resolveNextCursor,
  shouldProcessFeedEntry,
} from "./claim.ts";
import { RESIDENT_DISTILLER_AGENT_ID } from "./constants.ts";

describe("buildDistilledClaim", () => {
  it("sets inferred/derived identity and copies access tags", () => {
    const claim = buildDistilledClaim({
      title: "Decision",
      text: "Ship the feed first",
      sourceAccessTags: ["memory.owner:u1", "memory.doc:d1"],
      derivedFromVersionIds: ["kv_src"],
      temporalClass: "lesson",
    });
    expect(claim.generator_agent_id).toBe(RESIDENT_DISTILLER_AGENT_ID);
    expect(claim.provenance).toBe("inferred");
    expect(claim.lineage_class).toBe("derived");
    expect(claim.derived_from).toEqual(["kv_src"]);
    expect(claim.access_tags).toEqual(["memory.owner:u1", "memory.doc:d1"]);
    expect(claim.temporal_class).toBe("lesson");
  });
});

describe("shouldProcessFeedEntry", () => {
  it("skips own generator writes", () => {
    expect(
      shouldProcessFeedEntry({
        versionId: "v1",
        generatorAgentId: RESIDENT_DISTILLER_AGENT_ID,
      }),
    ).toBe(false);
  });

  it("accepts human / other agent writes", () => {
    expect(
      shouldProcessFeedEntry({ versionId: "v1", generatorAgentId: null }),
    ).toBe(true);
    expect(
      shouldProcessFeedEntry({
        versionId: "v1",
        generatorAgentId: "other-bot",
      }),
    ).toBe(true);
  });
});

describe("resolveNextCursor", () => {
  it("returns page cursor even on poison (fail-soft)", () => {
    expect(resolveNextCursor({ nextCursor: 42 }, { poison: true })).toBe(42);
    expect(resolveNextCursor({ nextCursor: null })).toBe(null);
  });
});
