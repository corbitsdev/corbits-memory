import { type } from "arktype";
import {
  EDGE_RELS,
  EDGE_REF_TYPES_ADAPTER,
  arktypeStringUnion,
} from "../enums.ts";

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

// Adapter-facing endpoint kinds. `native` is a planning-time hint resolved
// to an entity row at the capture write boundary; it is never stored on
// memory.edge.
export const MemoryEdgeRefTypeSchema = type(
  arktypeStringUnion(EDGE_REF_TYPES_ADAPTER) as
    "'document'|'version'|'chunk'|'entity'|'native'",
);
export type MemoryEdgeRefType = typeof MemoryEdgeRefTypeSchema.infer;

export const MemoryEdgeRelSchema = type(
  arktypeStringUnion(EDGE_RELS) as
    "'mentions'|'about'|'authored_by'|'involves'|'part_of'|'derived_from'|'supports'|'contradicts'|'supersedes'",
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
