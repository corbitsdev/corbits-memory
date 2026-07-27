import { describe, expect, it } from "bun:test";
import { formatCaughtError } from "./log.ts";
import { RerankHttpError } from "./core/rerank-client.ts";

describe("formatCaughtError", () => {
  it("returns an Error's message, unchanged", () => {
    expect(formatCaughtError(new Error("boom"))).toBe("boom");
  });

  it("carries a RerankHttpError's full diagnostic message (status, url, body) through untouched — this is the exact detail CL-4599 was dropping at render time", () => {
    const err = new RerankHttpError(
      413,
      '{"error":"Input validation error: `inputs` must have less than 512 tokens. Given: 855"}',
      "https://rerank.example/rerank",
    );
    const message = formatCaughtError(err);
    expect(message).toContain("413");
    expect(message).toContain("https://rerank.example/rerank");
    expect(message).toContain("must have less than 512 tokens");
  });

  it("stringifies a non-Error thrown value rather than dropping it", () => {
    expect(formatCaughtError("plain string throw")).toBe("plain string throw");
    expect(formatCaughtError(42)).toBe("42");
  });
});
