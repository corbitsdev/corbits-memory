import { describe, expect, it } from "bun:test";
import { mmrRerank } from "./mmr.ts";

describe("mmrRerank", () => {
  it("keeps the top-scoring item, then prefers a diverse item over a near-duplicate one", () => {
    const items = [
      { id: "best", vector: [1, 0, 0], score: 1.0 },
      // near-duplicate of "best" (same direction), scores second highest
      { id: "duplicate", vector: [0.99, 0.01, 0], score: 0.9 },
      // orthogonal to "best" — diverse, lower raw score
      { id: "diverse", vector: [0, 1, 0], score: 0.5 },
    ];

    const order = mmrRerank(items, 0.7, 3);

    // "best" always wins first pick (nothing picked yet to penalize it).
    expect(order[0]).toBe("best");
    // At lambda=0.7, "duplicate"'s near-1.0 similarity to "best" tanks its
    // MMR score (0.9 - 0.7*~0.999 ≈ 0.2) below "diverse"'s (0.5 - 0.7*0 =
    // 0.5), so diversity wins the second slot despite the lower raw score.
    expect(order[1]).toBe("diverse");
    expect(order[2]).toBe("duplicate");
  });

  it("never drops an item for lacking a vector — appends vector-less items in score order", () => {
    const items = [
      { id: "with-vector-low", vector: [1, 0], score: 0.3 },
      { id: "no-vector-high", score: 0.8 },
      { id: "with-vector-high", vector: [0, 1], score: 0.9 },
      { id: "no-vector-low", score: 0.1 },
    ];

    const order = mmrRerank(items, 0.7, 4);

    expect(order).toHaveLength(4);
    expect(new Set(order)).toEqual(
      new Set([
        "with-vector-low",
        "no-vector-high",
        "with-vector-high",
        "no-vector-low",
      ]),
    );
    // Vector-bearing items are placed by the greedy MMR pass first...
    expect(order.slice(0, 2)).toEqual(["with-vector-high", "with-vector-low"]);
    // ...vector-less items are appended after, in descending score order.
    expect(order.slice(2)).toEqual(["no-vector-high", "no-vector-low"]);
  });

  it("truncates to k after combining vector-bearing and vector-less items", () => {
    const items = [
      { id: "a", vector: [1, 0], score: 1.0 },
      { id: "b", score: 0.9 },
      { id: "c", vector: [0, 1], score: 0.1 },
    ];

    const order = mmrRerank(items, 0.7, 1);
    expect(order).toEqual(["a"]);
  });

  it("is a no-op ordering for a single item", () => {
    const order = mmrRerank(
      [{ id: "solo", vector: [1, 1], score: 0.5 }],
      0.7,
      5,
    );
    expect(order).toEqual(["solo"]);
  });
});
