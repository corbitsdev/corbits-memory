import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { AdaptedDocumentSchema } from "./adapted-document.ts";
import type { AdaptedDocument } from "./adapted-document.ts";

// T2 — a full AdaptedDocument fixture must parse with no errors.
describe("AdaptedDocumentSchema", () => {
  it("round-trips a full fixture", () => {
    const fixture: AdaptedDocument = {
      kind: "call_transcript",
      title: "Q3 renewal call",
      externalRef: "granola:note_123",
      accessTags: ["memory.tenant:t1"],
      attributes: { durationSec: 1800 },
      entityHints: [{ kind: "person", identifier: "jane@example.com" }],
      edges: [
        { rel: "about", to: { type: "entity", ref: "acme-co" } },
        { rel: "authored_by", to: { type: "native", ref: "principal_1" } },
      ],
      chunks: [
        { ordinal: 0, text: "Opening remarks.", role: "summary" },
        { ordinal: 1, text: "Pricing discussion." },
      ],
      rawPointer: { table: "granola_call_job", id: "job_1" },
      actor: { kind: "adapter" },
      contentHash: "sha256:abc123",
    };
    const out = AdaptedDocumentSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("parses without any of the optional fields", () => {
    const out = AdaptedDocumentSchema({
      kind: "task",
      title: "Follow up with Acme",
      externalRef: "task:1",
      accessTags: ["memory.owner:u1"],
      entityHints: [],
      chunks: [{ ordinal: 0, text: "Follow up with Acme on pricing." }],
      contentHash: "sha256:def456",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects a fixture missing contentHash", () => {
    const out = AdaptedDocumentSchema({
      kind: "task",
      title: "Follow up with Acme",
      externalRef: "task:1",
      accessTags: ["memory.owner:u1"],
      entityHints: [],
      chunks: [{ ordinal: 0, text: "Follow up with Acme on pricing." }],
    });
    expect(out instanceof type.errors).toBe(true);
  });
});
