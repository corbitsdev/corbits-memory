import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { AdaptedDocumentSchema } from "./adapted-document.ts";
import { MemoryEdgeHintSchema } from "./entity-edge.ts";
import type { AdaptedDocument } from "./adapted-document.ts";

/**
 * Claim-bearing write shape: a distilled claim is a normal AdaptedDocument
 * with inferred provenance, derived lineage, and a derived_from edge.
 * Core never runs inference — it only accepts this shape.
 */
describe("claim-bearing AdaptedDocument shape", () => {
  it("accepts a derived claim with provenance, lineage, and derived_from", () => {
    const claim: AdaptedDocument = {
      kind: "claim",
      title: "Acme renews in Q3",
      externalRef: "claim:acme-q3-renewal",
      accessTags: ["memory.tenant:t1"],
      entityHints: [{ kind: "org", identifier: "acme.com" }],
      edges: [
        {
          rel: "derived_from",
          to: { type: "version", ref: "kver_source_1" },
        },
        {
          rel: "supports",
          to: { type: "version", ref: "kver_prior_claim" },
        },
      ],
      chunks: [
        {
          ordinal: 0,
          text: "Acme is expected to renew in Q3 at a 12% expansion.",
        },
      ],
      actor: { kind: "agent", agentId: "distiller-v1" },
      sourceClass: "record",
      lineageClass: "derived",
      provenance: "inferred",
      contentHash: "sha256:claim-1",
    };
    const out = AdaptedDocumentSchema(claim);
    expect(out instanceof type.errors ? out.summary : out).toEqual(claim);
  });

  it("accepts every claim-bearing edge rel", () => {
    for (const rel of [
      "derived_from",
      "supports",
      "contradicts",
      "supersedes",
      "authored_by",
      "involves",
      "part_of",
    ] as const) {
      const out = MemoryEdgeHintSchema({
        rel,
        to: { type: "version", ref: "kver_1" },
      });
      expect(out instanceof type.errors).toBe(false);
    }
  });

  it("rejects pre-claim edge rels that were never DB-valid", () => {
    for (const rel of ["produced_by", "links", "parent", "waiting_on"]) {
      const out = MemoryEdgeHintSchema({
        rel,
        to: { type: "entity", ref: "e1" },
      });
      expect(out instanceof type.errors).toBe(true);
    }
  });

  it("keeps ranking sourceClass independent of lineageClass", () => {
    const out = AdaptedDocumentSchema({
      kind: "call_transcript",
      title: "Call",
      externalRef: "call:1",
      accessTags: ["memory.tenant:t1"],
      entityHints: [],
      chunks: [{ ordinal: 0, text: "hi" }],
      contentHash: "sha256:x",
      sourceClass: "channel",
      lineageClass: "native",
      provenance: "stated",
    });
    expect(out instanceof type.errors).toBe(false);
    if (!(out instanceof type.errors)) {
      expect(out.sourceClass).toBe("channel");
      expect(out.lineageClass).toBe("native");
    }
  });
});
