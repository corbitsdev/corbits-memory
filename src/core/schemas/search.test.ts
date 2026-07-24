import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { SearchHitSchema, SearchResponseSchema } from "./search.ts";
import type { SearchHit, SearchResponse } from "./search.ts";

function fullHitFixture(): SearchHit {
  return {
    chunk_id: "chunk_1",
    document_id: "doc_1",
    version: 3,
    version_id: "kv_3",
    status: "active",
    score: 0.87,
    title: "Q3 renewal call",
    snippet: "...agreed to renew at the same tier...",
    kind: "call_transcript",
    created_by_kind: "adapter",
    citation: {
      adapter: "granola",
      external_ref: "granola:note_123",
      open: { type: "call", id: "note_123", at: { tSec: 412 } },
    },
    entity_ids: ["entity_1"],
    channels_matched: ["lexical", "dense"],
  };
}

describe("SearchHitSchema", () => {
  it("round-trips a full fixture with a version-pinned citation", () => {
    const fixture = fullHitFixture();
    const out = SearchHitSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("parses citation.open without the optional at anchor", () => {
    const fixture = fullHitFixture();
    fixture.citation.open = { type: "artifact", id: "doc_1" };
    const out = SearchHitSchema(fixture);
    expect(out instanceof type.errors).toBe(false);
  });

  // T3 — a SearchHit missing version_id must fail arktype validation; the
  // citation must always be reproducible against the exact version it cites.
  it("rejects a hit missing version_id", () => {
    const fixture: Record<string, unknown> = fullHitFixture();
    delete fixture.version_id;
    const out = SearchHitSchema(fixture);
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("SearchResponseSchema", () => {
  // T5 — evidence: "weak" with no degraded field must still parse.
  it("parses a weak-evidence response with no degraded field", () => {
    const fixture: SearchResponse = {
      hits: [fullHitFixture()],
      evidence: "weak",
    };
    const out = SearchResponseSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("parses a none-evidence response with an empty hit list and degraded reasons", () => {
    const fixture: SearchResponse = {
      hits: [],
      evidence: "none",
      degraded: ["dense_unavailable", "lexical_only"],
    };
    const out = SearchResponseSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("rejects an invalid evidence value", () => {
    const out = SearchResponseSchema({ hits: [], evidence: "certain" });
    expect(out instanceof type.errors).toBe(true);
  });
});
