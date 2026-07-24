import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  KnowledgeEdgeHintSchema,
  KnowledgeEdgeSchema,
  KnowledgeEntitySchema,
} from "./entity-edge.ts";
import type { KnowledgeEdge } from "./entity-edge.ts";

describe("KnowledgeEntitySchema", () => {
  it("round-trips a full fixture", () => {
    const fixture = {
      id: "entity_1",
      tenant_id: "tenant_1",
      kind: "person",
      identifiers: { email: "jane@example.com" },
      created_at: "2026-07-19T00:00:00.000Z",
    };
    const out = KnowledgeEntitySchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });
});

describe("KnowledgeEdgeSchema", () => {
  it("round-trips a full fixture", () => {
    const fixture: KnowledgeEdge = {
      id: "edge_1",
      tenant_id: "tenant_1",
      rel: "about",
      from: { type: "document", ref: "doc_1" },
      to: { type: "entity", ref: "entity_1" },
      created_at: "2026-07-19T00:00:00.000Z",
    };
    const out = KnowledgeEdgeSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("rejects an unknown rel", () => {
    const out = KnowledgeEdgeSchema({
      id: "edge_1",
      tenant_id: "tenant_1",
      rel: "orbits",
      from: { type: "document", ref: "doc_1" },
      to: { type: "entity", ref: "entity_1" },
      created_at: "2026-07-19T00:00:00.000Z",
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

// T4 — a KnowledgeEdgeHint missing to.ref must fail arktype validation.
describe("KnowledgeEdgeHintSchema", () => {
  it("parses a full fixture", () => {
    const out = KnowledgeEdgeHintSchema({
      rel: "produced_by",
      to: { type: "native", ref: "principal_1" },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects a hint whose to is missing ref", () => {
    const out = KnowledgeEdgeHintSchema({
      rel: "produced_by",
      to: { type: "native" },
    });
    expect(out instanceof type.errors).toBe(true);
  });
});
