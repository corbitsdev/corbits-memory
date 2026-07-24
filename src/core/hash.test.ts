import { describe, expect, it } from "bun:test";
import { contentHash, stableStringify } from "./hash.ts";

describe("stableStringify", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = stableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = stableStringify({ a: 2, c: { y: 2, z: 1 }, b: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("contentHash", () => {
  const base = {
    title: "Q3 renewal brief",
    kind: "artifact",
    externalRef: "artifact:art_1",
    attributes: { status: "draft", count: 2 },
    chunkTexts: ["first chunk", "second chunk"],
  };

  it("is deterministic for identical logical input", () => {
    const h1 = contentHash(base);
    const h2 = contentHash({
      ...base,
      attributes: { count: 2, status: "draft" },
    });
    expect(h1).toBe(h2);
  });

  it("changes when chunk text changes", () => {
    const h1 = contentHash(base);
    const h2 = contentHash({ ...base, chunkTexts: ["first chunk", "different"] });
    expect(h1).not.toBe(h2);
  });

  it("changes when title changes", () => {
    const h1 = contentHash(base);
    const h2 = contentHash({ ...base, title: "Different title" });
    expect(h1).not.toBe(h2);
  });
});
