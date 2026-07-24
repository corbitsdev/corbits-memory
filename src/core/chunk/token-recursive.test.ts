import { describe, expect, it } from "bun:test";
import { chunkTokenRecursive } from "./token-recursive.ts";

function sentences(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      `Sentence number ${i} describes a small detail about the account.`,
    );
  }
  return parts.join(" ");
}

describe("chunkTokenRecursive", () => {
  it("T1: splits a 10k-char input into multiple chunks, each at or under maxTokens", () => {
    const text = sentences(160); // well over 10k chars
    expect(text.length).toBeGreaterThan(10_000);
    const chunks = chunkTokenRecursive(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(700);
    }
  });

  it("T2: a short input well under minTokens produces exactly one chunk", () => {
    const text = "A short note.";
    const chunks = chunkTokenRecursive(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(text);
    expect(chunks[0]?.ordinal).toBe(0);
    expect(chunks[0]?.metadata.strategy).toBe("token.recursive");
  });

  it("T3: empty string returns []", () => {
    expect(chunkTokenRecursive("")).toEqual([]);
  });

  it("T4: consecutive chunks overlap — the tail of chunk N appears at the head of chunk N+1", () => {
    const text = sentences(200);
    const chunks = chunkTokenRecursive(text, {
      maxTokens: 100,
      minTokens: 10,
      overlapTokens: 20,
    });
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 0; i < chunks.length - 1; i++) {
      const tail = chunks[i]?.text.slice(-40) ?? "";
      const nextChunkText = chunks[i + 1]?.text ?? "";
      const tailWords = tail.trim().split(/\s+/).slice(-3).join(" ");
      expect(nextChunkText.includes(tailWords)).toBe(true);
    }
  });

  it("T5: a trailing tiny remnant is merged into the previous chunk, not emitted standalone", () => {
    // Three words split on spaces with a tiny max forces 3 leaves; the third
    // leaf alone would fall under minTokens (minChars = 3*4 = 12).
    const text = "alpha beta gamma-delta-epsilon-zeta-eta-theta-iota z";
    const chunks = chunkTokenRecursive(text, {
      maxTokens: 10, // maxChars = 40
      minTokens: 3, // minChars = 12
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(0);
    const last = chunks[chunks.length - 1];
    expect(last).toBeDefined();
    expect(last!.text.length).toBeGreaterThanOrEqual(12);
    // The final chunk's text absorbed the tiny trailing " z" remnant rather
    // than emitting it as its own sub-minTokens chunk.
    expect(last!.text.endsWith("z")).toBe(true);
  });

  it("carries a strategy id and 0-based ordinal on every chunk", () => {
    const chunks = chunkTokenRecursive(sentences(50));
    chunks.forEach((chunk, index) => {
      expect(chunk.ordinal).toBe(index);
      expect(chunk.metadata).toEqual({ strategy: "token.recursive" });
      expect(chunk.span.start).toBeLessThan(chunk.span.end);
    });
  });
});
