import { type } from "arktype";

// chunk_id is a hash of (document_id, version, ordinal); chunks are never
// reused across versions.
export const KnowledgeChunkSchema = type({
  id: "string",
  tenant_id: "string",
  version_id: "string",
  document_id: "string",
  ordinal: "number",
  text: "string",
  "role?": "string",
  created_at: "string",
});
export type KnowledgeChunk = typeof KnowledgeChunkSchema.infer;
