import { describe, expect, it } from "bun:test";

import {
  mergeLocalLiveV1,
  recencyPrior,
  withTimeout,
  type MergeChannelItem,
} from "./merge-local-live.ts";

const NOW = Date.parse("2026-03-08T12:00:00.000Z");

function citation(adapter: string, ref: string) {
  return {
    adapter,
    external_ref: ref,
    open: { type: "doc", id: ref, url: `https://ex.test/${ref}` },
  };
}

function local(
  overrides: Partial<MergeChannelItem> & {
    externalRef: string;
    score: number;
  },
): MergeChannelItem {
  const ref = overrides.externalRef;
  return {
    channel: "local",
    adapter: overrides.adapter ?? "mcp",
    externalRef: ref,
    documentId: overrides.documentId ?? `local_${ref}`,
    title: overrides.title ?? `Local ${ref}`,
    snippet: overrides.snippet ?? "local body",
    score: overrides.score,
    kind: overrides.kind ?? "note",
    citation: overrides.citation ?? citation(overrides.adapter ?? "mcp", ref),
    ...(overrides.updatedAt !== undefined
      ? { updatedAt: overrides.updatedAt }
      : {}),
  };
}

function live(
  overrides: Partial<MergeChannelItem> & {
    externalRef: string;
    score: number;
    adapter?: string;
  },
): MergeChannelItem {
  const adapter = overrides.adapter ?? "linear";
  const ref = overrides.externalRef;
  return {
    channel: "live",
    adapter,
    externalRef: ref,
    documentId: overrides.documentId ?? ref,
    title: overrides.title ?? `Live ${ref}`,
    snippet: overrides.snippet ?? "live body",
    score: overrides.score,
    kind: overrides.kind ?? "issue",
    citation: overrides.citation ?? citation(adapter, ref),
    ...(overrides.updatedAt !== undefined
      ? { updatedAt: overrides.updatedAt }
      : {}),
  };
}

describe("mergeLocalLiveV1", () => {
  // T1 — collision/dedupe: same adapter:ref → one hit, local body wins
  it("T1: prefer-local on adapter:externalRef collision", () => {
    const result = mergeLocalLiveV1({
      local: [
        local({
          externalRef: "CL-1",
          adapter: "linear",
          score: 0.4,
          title: "local title",
          snippet: "local wins",
        }),
      ],
      live: [
        live({
          externalRef: "CL-1",
          adapter: "linear",
          score: 0.99,
          title: "live title",
          snippet: "live loses",
        }),
      ],
      limit: 10,
      nowMs: NOW,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.channel).toBe("local");
    expect(result.items[0]?.snippet).toBe("local wins");
    expect(result.items[0]?.title).toBe("local title");
  });

  // T2 — source filter applied
  it("T2: source filter keeps only requested channels", () => {
    const result = mergeLocalLiveV1({
      local: [local({ externalRef: "a", score: 1, title: "only local" })],
      live: [
        live({
          externalRef: "b",
          adapter: "linear",
          score: 1,
          title: "linear hit",
        }),
        live({
          externalRef: "c",
          adapter: "drive",
          score: 1,
          title: "drive hit",
        }),
      ],
      limit: 10,
      sources: ["linear"],
      nowMs: NOW,
    });
    expect(result.items.map((i) => i.title)).toEqual(["linear hit"]);
  });

  // T3 — empty local set
  it("T3: empty local returns live only", () => {
    const result = mergeLocalLiveV1({
      local: [],
      live: [live({ externalRef: "x", score: 0.8 })],
      limit: 5,
      nowMs: NOW,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.channel).toBe("live");
  });

  // T4 — empty live set
  it("T4: empty live returns local only", () => {
    const result = mergeLocalLiveV1({
      local: [local({ externalRef: "y", score: 0.7 })],
      live: [],
      limit: 5,
      nowMs: NOW,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.channel).toBe("local");
  });

  // T5 — both empty
  it("T5: both empty → no items", () => {
    const result = mergeLocalLiveV1({
      local: [],
      live: [],
      limit: 5,
      nowMs: NOW,
    });
    expect(result.items).toEqual([]);
  });

  // T6 — recency prior breaks ties (same norm score)
  it("T6: recency prior ranks fresher doc first on equal relevance", () => {
    const result = mergeLocalLiveV1({
      local: [
        local({
          externalRef: "old",
          score: 1,
          title: "old doc",
          updatedAt: "2025-01-01T00:00:00.000Z",
        }),
        local({
          externalRef: "new",
          score: 1,
          title: "new doc",
          updatedAt: "2026-03-01T00:00:00.000Z",
        }),
      ],
      live: [],
      limit: 2,
      nowMs: NOW,
    });
    expect(result.items[0]?.title).toBe("new doc");
    expect(result.items[1]?.title).toBe("old doc");
  });

  // T7 — prefer-local wins ties over live even with lower raw score after norm
  it("T7: prefer-local wins over live on same key regardless of live score", () => {
    const result = mergeLocalLiveV1({
      local: [
        local({
          externalRef: "same",
          adapter: "linear",
          score: 0.01,
          snippet: "local body",
        }),
      ],
      live: [
        live({
          externalRef: "same",
          adapter: "linear",
          score: 100,
          snippet: "live body",
        }),
      ],
      limit: 1,
      nowMs: NOW,
    });
    expect(result.items[0]?.snippet).toBe("local body");
    expect(result.items[0]?.channel).toBe("local");
  });

  // T8 — limit truncates after merge
  it("T8: limit truncates merged ranking", () => {
    const result = mergeLocalLiveV1({
      local: [
        local({ externalRef: "1", score: 3 }),
        local({ externalRef: "2", score: 2 }),
      ],
      live: [
        live({ externalRef: "3", score: 1, title: "third" }),
      ],
      limit: 2,
      nowMs: NOW,
    });
    expect(result.items).toHaveLength(2);
  });

  it("source filter can keep local only", () => {
    const result = mergeLocalLiveV1({
      local: [local({ externalRef: "a", score: 1 })],
      live: [live({ externalRef: "b", score: 1 })],
      limit: 10,
      sources: ["local"],
      nowMs: NOW,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.channel).toBe("local");
  });
});

describe("recencyPrior", () => {
  it("returns ~1 for now and decays with age", () => {
    const fresh = recencyPrior(new Date(NOW).toISOString(), NOW);
    const old = recencyPrior("2020-01-01T00:00:00.000Z", NOW);
    expect(fresh).toBeGreaterThan(0.99);
    expect(old).toBeLessThan(0.1);
  });

  it("returns neutral 0.5 when timestamp missing", () => {
    expect(recencyPrior(undefined, NOW)).toBe(0.5);
  });
});

describe("withTimeout", () => {
  it("resolves when the promise wins the race", async () => {
    const v = await withTimeout(Promise.resolve(42), 100);
    expect(v).toBe(42);
  });

  it("rejects with live_timeout when the promise is slow", async () => {
    const slow = new Promise<number>((resolve) => {
      setTimeout(() => resolve(1), 50);
    });
    try {
      await withTimeout(slow, 5);
      throw new Error("expected timeout");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("live_timeout");
    }
  });
});
