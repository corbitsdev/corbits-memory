import { describe, expect, it } from "bun:test";
import {
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  FEED_LIMIT_MIN,
  FeedInputError,
  feedPageAfterAccessFilter,
} from "./feed.ts";

describe("feed constants", () => {
  it("bounds page size", () => {
    expect(FEED_LIMIT_MIN).toBe(1);
    expect(FEED_LIMIT_DEFAULT).toBeLessThanOrEqual(FEED_LIMIT_MAX);
    expect(FEED_LIMIT_MAX).toBe(100);
  });
});

describe("FeedInputError", () => {
  it("is a 400-class error", () => {
    const err = new FeedInputError("bad cursor");
    expect(err.status).toBe(400);
    expect(err.message).toBe("bad cursor");
  });
});

describe("feedPageAfterAccessFilter", () => {
  it("keeps raw nextCursor when ACL denies the whole page", () => {
    const raw = {
      entries: [{ feedSeq: 10 }, { feedSeq: 11 }],
      nextCursor: 11,
    };
    const page = feedPageAfterAccessFilter(raw, []);
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBe(11);
  });

  it("keeps raw nextCursor when some entries are allowed", () => {
    const raw = {
      entries: [{ feedSeq: 1 }, { feedSeq: 2 }, { feedSeq: 3 }],
      nextCursor: 3,
    };
    const allowed = [{ feedSeq: 1 }];
    const page = feedPageAfterAccessFilter(raw, allowed);
    expect(page.entries).toEqual(allowed);
    // Not the last allowed feedSeq (1) — advance past examined raw page.
    expect(page.nextCursor).toBe(3);
  });

  it("returns null nextCursor when raw page is empty (end of feed)", () => {
    const page = feedPageAfterAccessFilter(
      { entries: [], nextCursor: null },
      [],
    );
    expect(page.nextCursor).toBeNull();
  });
});
