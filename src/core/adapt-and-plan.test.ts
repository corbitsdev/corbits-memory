import { describe, expect, it } from "bun:test";
import { adaptAndPlan, InvalidAdaptedDocumentError } from "./adapt-and-plan.ts";
import type { AdaptedDocument } from "./schemas/adapted-document.ts";

function validAdaptedDocument(
  overrides: Partial<AdaptedDocument> = {},
): AdaptedDocument {
  return {
    kind: "artifact",
    title: "Q3 renewal brief",
    externalRef: "artifact:art_1",
    visibility: { mode: "principals", principalIds: ["principal_1"] },
    entityHints: [],
    chunks: [
      { ordinal: 0, text: "The account renews in Q3 with a 12% expansion." },
    ],
    contentHash: "placeholder",
    ...overrides,
  };
}

describe("adaptAndPlan", () => {
  it("T1: the same input produces an identical contentHash both times", () => {
    const plan1 = adaptAndPlan(validAdaptedDocument());
    const plan2 = adaptAndPlan(validAdaptedDocument());
    expect(plan1.contentHash).toBe(plan2.contentHash);
  });

  it("T2: an empty kind throws InvalidAdaptedDocumentError", () => {
    expect(() => adaptAndPlan(validAdaptedDocument({ kind: "" }))).toThrow(
      InvalidAdaptedDocumentError,
    );
  });

  it("throws on an empty title too", () => {
    expect(() => adaptAndPlan(validAdaptedDocument({ title: "  " }))).toThrow(
      InvalidAdaptedDocumentError,
    );
  });

  it("changes the contentHash when the chunk text changes", () => {
    const plan1 = adaptAndPlan(validAdaptedDocument());
    const plan2 = adaptAndPlan(
      validAdaptedDocument({
        chunks: [{ ordinal: 0, text: "Something entirely different." }],
      }),
    );
    expect(plan1.contentHash).not.toBe(plan2.contentHash);
  });

  it("carries entityHints and edges through from the adapted document", () => {
    const plan = adaptAndPlan(
      validAdaptedDocument({
        edges: [{ rel: "links", to: { type: "native", ref: "mail:m1" } }],
        entityHints: [{ kind: "person", identifier: "jane@example.com" }],
      }),
    );
    expect(plan.edges).toEqual([
      { rel: "links", to: { type: "native", ref: "mail:m1" } },
    ]);
    expect(plan.entityHints).toEqual([
      { kind: "person", identifier: "jane@example.com" },
    ]);
  });

  it("assigns span and tokenCount to every output chunk", () => {
    const text = "The account renews in Q3 with a 12% expansion.";
    const plan = adaptAndPlan(
      validAdaptedDocument({ chunks: [{ ordinal: 0, text }] }),
    );
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]?.span).toEqual({ start: 0, end: text.length });
    expect(plan.chunks[0]?.tokenCount).toBeGreaterThan(0);
  });

  it("accepts an injected chunker port instead of the default", () => {
    let calls = 0;
    const plan = adaptAndPlan(validAdaptedDocument(), {
      chunker: (text) => {
        calls += 1;
        return [
          {
            ordinal: 0,
            text,
            tokenCount: 1,
            span: { start: 0, end: text.length },
            metadata: { strategy: "token.recursive" },
          },
        ];
      },
    });
    expect(calls).toBe(1);
    expect(plan.chunks[0]?.tokenCount).toBe(1);
  });

  it("defaults edges to an empty array when the adapted document omits them", () => {
    const plan = adaptAndPlan(validAdaptedDocument());
    expect(plan.edges).toEqual([]);
  });
});
