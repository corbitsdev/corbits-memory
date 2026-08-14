import { type } from "arktype";

export const MemoryVersionStatusSchema = type(
  "'active'|'superseded'|'deprecated'|'archived'|'tombstoned'",
);
export type MemoryVersionStatus = typeof MemoryVersionStatusSchema.infer;

export const CreatedByKindSchema = type("'human'|'agent'|'system'|'adapter'");
export type CreatedByKind = typeof CreatedByKindSchema.infer;

// The stable logical row for a captured source, deduped on (tenant_id,
// adapter, external_ref). Document access is grant tags only.
export const MemoryDocumentSchema = type({
  id: "string",
  tenant_id: "string",
  kind: "string",
  title: "string",
  adapter: "string",
  external_ref: "string",
  access_tags: "string[]",
  attributes: "Record<string, string | number | boolean | null>",
  created_at: "string",
  last_seen_at: "string",
});
export type MemoryDocument = typeof MemoryDocumentSchema.infer;

// The versioned body of a document. Chunks belong to a version_id, never
// reused across versions.
export const MemoryVersionSchema = type({
  id: "string",
  tenant_id: "string",
  document_id: "string",
  version: "number",
  version_id: "string",
  supersedes_version_id: "string | null",
  status: MemoryVersionStatusSchema,
  content_hash: "string",
  occurred_at: "string",
  ingested_at: "string",
  deprecated_at: "string | null",
  deprecated_reason: "string | null",
  created_by_principal_id: "string | null",
  created_by_kind: CreatedByKindSchema,
  "generator_agent_id?": "string",
});
export type MemoryVersion = typeof MemoryVersionSchema.infer;
