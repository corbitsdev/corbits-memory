import { describe, expect, it } from "bun:test";
import {
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  FEED_LIMIT_MIN,
  FeedInputError,
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
