import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  MemoryEdgeHintSchema,
  MemoryEdgeSchema,
  MemoryEntitySchema,
} from "./entity-edge.ts";
import type { MemoryEdge } from "./entity-edge.ts";

describe("MemoryEntitySchema", () => {
  it("round-trips a full fixture", () => {
    const fixture = {
      id: "entity_1",
      tenant_id: "tenant_1",
      kind: "person",
      identifiers: { email: "jane@example.com" },
      created_at: "2026-07-19T00:00:00.000Z",
    };
    const out = MemoryEntitySchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });
});

describe("MemoryEdgeSchema", () => {
  it("round-trips a full fixture", () => {
    const fixture: MemoryEdge = {
      id: "edge_1",
      tenant_id: "tenant_1",
      rel: "about",
      from: { type: "document", ref: "doc_1" },
      to: { type: "entity", ref: "entity_1" },
      created_at: "2026-07-19T00:00:00.000Z",
    };
    const out = MemoryEdgeSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("rejects an unknown rel", () => {
    const out = MemoryEdgeSchema({
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

// T4 — a MemoryEdgeHint missing to.ref must fail arktype validation.
describe("MemoryEdgeHintSchema", () => {
  it("parses a full fixture", () => {
    const out = MemoryEdgeHintSchema({
      rel: "authored_by",
      to: { type: "native", ref: "principal_1" },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects a hint whose to is missing ref", () => {
    const out = MemoryEdgeHintSchema({
      rel: "authored_by",
      to: { type: "native" },
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("accepts version and chunk endpoint types", () => {
    for (const endpointType of ["version", "chunk"] as const) {
      const out = MemoryEdgeHintSchema({
        rel: "derived_from",
        to: { type: endpointType, ref: "id_1" },
      });
      expect(out instanceof type.errors).toBe(false);
    }
  });
});
