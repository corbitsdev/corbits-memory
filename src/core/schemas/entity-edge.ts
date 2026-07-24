import { type } from "arktype";

// A real-world thing (person, org, deal, ...) a document or chunk mentions.
// Kept lightweight — identity keys only (email, domain, ...), not another
// copy of chunk text.
export const KnowledgeEntitySchema = type({
  id: "string",
  tenant_id: "string",
  kind: "string",
  identifiers: "Record<string, string>",
  created_at: "string",
});
export type KnowledgeEntity = typeof KnowledgeEntitySchema.infer;

export const KnowledgeEdgeRefTypeSchema = type("'document'|'entity'|'native'");
export type KnowledgeEdgeRefType = typeof KnowledgeEdgeRefTypeSchema.infer;

export const KnowledgeEdgeRelSchema = type(
  "'about'|'produced_by'|'links'|'parent'|'mentions'|'waiting_on'",
);
export type KnowledgeEdgeRel = typeof KnowledgeEdgeRelSchema.infer;

export const KnowledgeEdgeRefSchema = type({
  type: KnowledgeEdgeRefTypeSchema,
  ref: "string",
});
export type KnowledgeEdgeRef = typeof KnowledgeEdgeRefSchema.infer;

// Graph structure between documents/entities/native refs (e.g. principals).
// Lightweight rows only.
export const KnowledgeEdgeSchema = type({
  id: "string",
  tenant_id: "string",
  rel: KnowledgeEdgeRelSchema,
  from: KnowledgeEdgeRefSchema,
  to: KnowledgeEdgeRefSchema,
  created_at: "string",
});
export type KnowledgeEdge = typeof KnowledgeEdgeSchema.infer;

// The edge hint an adapter emits on an AdaptedDocument — "from" is implicit
// (the document being adapted), so only "rel" and "to" are carried.
export const KnowledgeEdgeHintSchema = type({
  rel: KnowledgeEdgeRelSchema,
  to: KnowledgeEdgeRefSchema,
});
export type KnowledgeEdgeHint = typeof KnowledgeEdgeHintSchema.infer;
