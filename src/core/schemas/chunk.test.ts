import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { MemoryChunkSchema } from "./chunk.ts";

describe("MemoryChunkSchema", () => {
  it("round-trips a full fixture", () => {
    const fixture = {
      id: "chunk_1",
      tenant_id: "tenant_1",
      version_id: "kv_1",
      document_id: "doc_1",
      ordinal: 0,
      text: "We agreed to renew at the same tier.",
      role: "summary",
      created_at: "2026-07-19T00:00:00.000Z",
    };
    const out = MemoryChunkSchema(fixture);
    expect(out instanceof type.errors ? out.summary : out).toEqual(fixture);
  });

  it("parses without the optional role", () => {
    const out = MemoryChunkSchema({
      id: "chunk_1",
      tenant_id: "tenant_1",
      version_id: "kv_1",
      document_id: "doc_1",
      ordinal: 0,
      text: "We agreed to renew at the same tier.",
      created_at: "2026-07-19T00:00:00.000Z",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects a chunk missing version_id", () => {
    const out = MemoryChunkSchema({
      id: "chunk_1",
      tenant_id: "tenant_1",
      document_id: "doc_1",
      ordinal: 0,
      text: "We agreed to renew at the same tier.",
      created_at: "2026-07-19T00:00:00.000Z",
    });
    expect(out instanceof type.errors).toBe(true);
  });
});
