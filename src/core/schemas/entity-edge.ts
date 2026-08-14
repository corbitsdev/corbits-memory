import { type } from "arktype";

// A real-world thing (person, org, deal, ...) a document or chunk mentions.
// Kept lightweight — identity keys only (email, domain, ...), not another
// copy of chunk text.
export const MemoryEntitySchema = type({
  id: "string",
  tenant_id: "string",
  kind: "string",
  identifiers: "Record<string, string>",
  created_at: "string",
});
export type MemoryEntity = typeof MemoryEntitySchema.infer;

export const MemoryEdgeRefTypeSchema = type("'document'|'entity'|'native'");
export type MemoryEdgeRefType = typeof MemoryEdgeRefTypeSchema.infer;

export const MemoryEdgeRelSchema = type(
  "'about'|'produced_by'|'links'|'parent'|'mentions'|'waiting_on'",
);
export type MemoryEdgeRel = typeof MemoryEdgeRelSchema.infer;

export const MemoryEdgeRefSchema = type({
  type: MemoryEdgeRefTypeSchema,
  ref: "string",
});
export type MemoryEdgeRef = typeof MemoryEdgeRefSchema.infer;

// Graph structure between documents/entities/native refs (e.g. principals).
// Lightweight rows only.
export const MemoryEdgeSchema = type({
  id: "string",
  tenant_id: "string",
  rel: MemoryEdgeRelSchema,
  from: MemoryEdgeRefSchema,
  to: MemoryEdgeRefSchema,
  created_at: "string",
});
export type MemoryEdge = typeof MemoryEdgeSchema.infer;

// The edge hint an adapter emits on an AdaptedDocument — "from" is implicit
// (the document being adapted), so only "rel" and "to" are carried.
export const MemoryEdgeHintSchema = type({
  rel: MemoryEdgeRelSchema,
  to: MemoryEdgeRefSchema,
});
export type MemoryEdgeHint = typeof MemoryEdgeHintSchema.infer;
