import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  MemoryDocumentSchema,
  MemoryVersionSchema,
} from "./document.ts";
import type { MemoryDocument, MemoryVersion } from "./document.ts";

describe("MemoryDocumentSchema", () => {
  it("round-trips a full fixture", () => {
    const fixture: MemoryDocument = {
      id: "doc_1",
      tenant_id: "tenant_1",
      kind: "call_transcript",
      title: "Q3 renewal call",
      adapter: "granola",
      external_ref: "granola:note_123",
      access_tags: ["memory.tenant:tenant_1"],
      attributes: { channel: "call", pinned: true, score: null },
      created_at: "2026-07-19T00:00:00.000Z",
      last_seen_at: "2026-07-19T00:00:00.000Z",
    };
    const out = MemoryDocumentSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("rejects a document missing external_ref", () => {
    const out = MemoryDocumentSchema({
      id: "doc_1",
      tenant_id: "tenant_1",
      kind: "call_transcript",
      title: "Q3 renewal call",
      adapter: "granola",
      access_tags: ["memory.tenant:tenant_1"],
      attributes: {},
      created_at: "2026-07-19T00:00:00.000Z",
      last_seen_at: "2026-07-19T00:00:00.000Z",
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("MemoryVersionSchema", () => {
  it("round-trips a full fixture", () => {
    const fixture: MemoryVersion = {
      id: "kv_1",
      tenant_id: "tenant_1",
      document_id: "doc_1",
      version: 1,
      version_id: "kv_1",
      supersedes_version_id: null,
      status: "active",
      content_hash: "sha256:abc",
      occurred_at: "2026-07-19T00:00:00.000Z",
      ingested_at: "2026-07-19T00:00:01.000Z",
      deprecated_at: null,
      deprecated_reason: null,
      created_by_principal_id: "principal_1",
      created_by_kind: "human",
      provenance: "stated",
      source_class: "native",
      temporal_class: "event",
    };
    const out = MemoryVersionSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("rejects an invalid status", () => {
    const out = MemoryVersionSchema({
      id: "kv_1",
      tenant_id: "tenant_1",
      document_id: "doc_1",
      version: 1,
      version_id: "kv_1",
      supersedes_version_id: null,
      status: "final",
      content_hash: "sha256:abc",
      occurred_at: "2026-07-19T00:00:00.000Z",
      ingested_at: "2026-07-19T00:00:01.000Z",
      deprecated_at: null,
      deprecated_reason: null,
      created_by_principal_id: null,
      created_by_kind: "human",
      provenance: "stated",
      source_class: "native",
      temporal_class: "event",
    });
    expect(out instanceof type.errors).toBe(true);
  });
});
