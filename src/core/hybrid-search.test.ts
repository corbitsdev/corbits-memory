import { describe, expect, test } from "bun:test";
import {
  BOOST_MULTIPLIER_MAX,
  BOOST_MULTIPLIER_MIN,
  MAX_BATCH_QUERIES,
  RECENCY_HALF_LIFE_MS,
  authorityBoostMultiplier,
  clampBoostMultiplier,
  clampOverfetchMultiplier,
  fuseRrf,
  isBatchQueriesWithinBound,
  normalizeScoresToUnit,
  recencyBoostMultiplier,
  toRankedCandidates,
} from "./hybrid-search.ts";

describe("toRankedCandidates", () => {
  test("assigns 1-based rank in list order", () => {
    expect(toRankedCandidates(["a", "b", "c"])).toEqual([
      { chunkId: "a", rank: 1 },
      { chunkId: "b", rank: 2 },
      { chunkId: "c", rank: 3 },
    ]);
  });
});

describe("fuseRrf", () => {
  // Hand-computed RRF (rrfK=60):
  // lexical: [A,B,C,D] ranks 1..4; dense: [C,A,E,F] ranks 1..4
  // score(A) = 1/61 + 1/62 = 0.0325224...
  // score(B) = 1/62               = 0.0161290...
  // score(C) = 1/63 + 1/61        = 0.0322664...
  // score(D) = 1/64               = 0.0156250
  // score(E) = 1/63               = 0.0158730...
  // score(F) = 1/64               = 0.0156250
  // Expected descending order: A, C, B, E, then D/F tied last.
  test("fuses two ranked channels by reciprocal rank, never raw score averaging", () => {
    const lexical = toRankedCandidates(["A", "B", "C", "D"]);
    const dense = toRankedCandidates(["C", "A", "E", "F"]);

    const fused = fuseRrf([lexical, dense]);

    expect(fused.map((f) => f.chunkId).slice(0, 3)).toEqual(["A", "C", "B"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused[1]?.score).toBeCloseTo(1 / 63 + 1 / 61, 10);
    expect(fused[2]?.score).toBeCloseTo(1 / 62, 10);

    const tailIds = fused.slice(3).map((f) => f.chunkId);
    expect(new Set(tailIds)).toEqual(new Set(["E", "D", "F"]));
  });

  test("a chunk present in only one channel is still scored (not dropped)", () => {
    const lexical = toRankedCandidates(["only-lexical"]);
    const dense: ReturnType<typeof toRankedCandidates> = [];

    const fused = fuseRrf([lexical, dense]);

    expect(fused).toEqual([{ chunkId: "only-lexical", score: 1 / 61 }]);
  });

  test("empty channels produce no candidates", () => {
    expect(fuseRrf([[], []])).toEqual([]);
  });

  // This test protects the invariant documented on fuseRrf above: fusion
  // reads a candidate's own rank within its channel and nothing else — not
  // how many candidates that channel started with or how many survived. If
  // fuseRrf is ever rewritten to blend on something pool-size- or
  // fraction-aware (e.g. normalizing rank to a percentile of the channel),
  // this test must fail, because that is precisely the property being
  // protected.
  test("fuses by raw rank only, never by the size of the pool a candidate survived from", () => {
    // "Y" is the worst survivor of a channel heavily thinned by filtering
    // (rank 2 of ~2 candidates). "X" is a solid-but-unremarkable finisher in
    // a channel filtering barely touched (rank 10 of ~100 candidates). This
    // is exactly the shape independent per-channel filtering produces.
    //
    // Hand-computed RRF (rrfK=60), which reads only the rank number:
    //   score(Y) = 1/(60+2)  = 1/62 ≈ 0.0161290
    //   score(X) = 1/(60+10) = 1/70 ≈ 0.0142857
    // Y's raw rank (2) beats X's raw rank (10), so rank-based fusion ranks
    // Y above X.
    //
    // A score-blending fusion that normalized each rank to a percentile
    // within its own channel ((total - rank + 1) / total) would compute the
    // OPPOSITE order:
    //   percentile(Y) = (2 - 2 + 1) / 2     = 0.50 (bottom half of a tiny pool)
    //   percentile(X) = (100 - 10 + 1) / 100 = 0.91 (top decile of a large pool)
    // ranking X above Y. A change to that kind of blending flips this
    // assertion and fails the test.
    const heavilyFilteredChannel = [{ chunkId: "Y", rank: 2 }];
    const mostlyIntactChannel = [{ chunkId: "X", rank: 10 }];

    const fused = fuseRrf([heavilyFilteredChannel, mostlyIntactChannel]);

    expect(fused.map((f) => f.chunkId)).toEqual(["Y", "X"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 62, 10);
    expect(fused[1]?.score).toBeCloseTo(1 / 70, 10);
  });
});

describe("isBatchQueriesWithinBound", () => {
  test("accepts 1 through MAX_BATCH_QUERIES", () => {
    expect(isBatchQueriesWithinBound(["a"])).toBe(true);
    expect(isBatchQueriesWithinBound(Array(MAX_BATCH_QUERIES).fill("q"))).toBe(
      true,
    );
  });

  test("rejects zero queries", () => {
    expect(isBatchQueriesWithinBound([])).toBe(false);
  });

  test("rejects more than MAX_BATCH_QUERIES", () => {
    expect(
      isBatchQueriesWithinBound(Array(MAX_BATCH_QUERIES + 1).fill("q")),
    ).toBe(false);
  });
});

describe("clampOverfetchMultiplier", () => {
  test("clamps below the documented floor up to 3x", () => {
    expect(clampOverfetchMultiplier(1)).toBe(3);
  });

  test("clamps above the documented ceiling down to 10x", () => {
    expect(clampOverfetchMultiplier(50)).toBe(10);
  });

  test("passes through an in-range multiplier unchanged", () => {
    expect(clampOverfetchMultiplier(5)).toBe(5);
  });
});

describe("normalizeScoresToUnit", () => {
  test("maps a spread of scores onto [0,1] endpoints", () => {
    expect(normalizeScoresToUnit([2, 4, 6])).toEqual([0, 0.5, 1]);
  });

  test("a degenerate all-equal batch normalizes every item to 1", () => {
    // No basis to rank them apart; collapsing to 0 would zero their boosts.
    expect(normalizeScoresToUnit([5, 5, 5])).toEqual([1, 1, 1]);
    expect(normalizeScoresToUnit([9])).toEqual([1]);
  });

  test("an empty batch yields an empty result", () => {
    expect(normalizeScoresToUnit([])).toEqual([]);
  });
});

describe("clampBoostMultiplier", () => {
  test("clamps to the locked [0.7, 1.3] bound", () => {
    expect(clampBoostMultiplier(0.1)).toBe(BOOST_MULTIPLIER_MIN);
    expect(clampBoostMultiplier(9)).toBe(BOOST_MULTIPLIER_MAX);
    expect(clampBoostMultiplier(1)).toBe(1);
  });
});

describe("authorityBoostMultiplier", () => {
  test("zero authority sits at the floor, full authority at the ceiling", () => {
    expect(authorityBoostMultiplier(0)).toBeCloseTo(BOOST_MULTIPLIER_MIN, 10);
    expect(authorityBoostMultiplier(1)).toBeCloseTo(BOOST_MULTIPLIER_MAX, 10);
  });

  test("mid authority lands between the bounds, monotonic in authority", () => {
    expect(authorityBoostMultiplier(0.5)).toBeCloseTo(1, 10);
    expect(authorityBoostMultiplier(0.8)).toBeGreaterThan(
      authorityBoostMultiplier(0.2),
    );
  });
});

describe("recencyBoostMultiplier", () => {
  const now = new Date("2026-07-20T00:00:00.000Z");

  test("a brand-new document gets the full recency ceiling", () => {
    expect(recencyBoostMultiplier(now, now)).toBeCloseTo(
      BOOST_MULTIPLIER_MAX,
      10,
    );
  });

  test("one half-life old decays to the midpoint of the boost span", () => {
    const oneHalfLifeAgo = new Date(now.getTime() - RECENCY_HALF_LIFE_MS);
    // decay = 2^-1 = 0.5 → 0.7 + 0.6*0.5 = 1.0
    expect(recencyBoostMultiplier(oneHalfLifeAgo, now)).toBeCloseTo(1, 10);
  });

  test("a far-future occurredAt does not exceed the ceiling", () => {
    const future = new Date(now.getTime() + RECENCY_HALF_LIFE_MS);
    expect(recencyBoostMultiplier(future, now)).toBeCloseTo(
      BOOST_MULTIPLIER_MAX,
      10,
    );
  });
});
