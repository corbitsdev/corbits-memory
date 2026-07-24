import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  KnowledgeDocumentSchema,
  KnowledgeVersionSchema,
  VisibilitySpecSchema,
} from "./document.ts";
import type { KnowledgeDocument, KnowledgeVersion } from "./document.ts";

describe("VisibilitySpecSchema", () => {
  it("parses a tenant-mode spec with no optional fields", () => {
    const out = VisibilitySpecSchema({ mode: "tenant" });
    expect(out instanceof type.errors ? out.summary : out).toEqual({
      mode: "tenant",
    });
  });

  it("rejects an unknown mode", () => {
    const out = VisibilitySpecSchema({ mode: "public" });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("KnowledgeDocumentSchema", () => {
  it("round-trips a full fixture", () => {
    const fixture: KnowledgeDocument = {
      id: "doc_1",
      tenant_id: "tenant_1",
      kind: "call_transcript",
      title: "Q3 renewal call",
      adapter: "granola",
      external_ref: "granola:note_123",
      visibility: { mode: "tenant" },
      attributes: { channel: "call", pinned: true, score: null },
      created_at: "2026-07-19T00:00:00.000Z",
      last_seen_at: "2026-07-19T00:00:00.000Z",
    };
    const out = KnowledgeDocumentSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("rejects a document missing external_ref", () => {
    const out = KnowledgeDocumentSchema({
      id: "doc_1",
      tenant_id: "tenant_1",
      kind: "call_transcript",
      title: "Q3 renewal call",
      adapter: "granola",
      visibility: { mode: "tenant" },
      attributes: {},
      created_at: "2026-07-19T00:00:00.000Z",
      last_seen_at: "2026-07-19T00:00:00.000Z",
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("KnowledgeVersionSchema", () => {
  it("round-trips a full fixture", () => {
    const fixture: KnowledgeVersion = {
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
    };
    const out = KnowledgeVersionSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("rejects an invalid status", () => {
    const out = KnowledgeVersionSchema({
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
    });
    expect(out instanceof type.errors).toBe(true);
  });
});
