import { type } from "arktype";
import {
  LINEAGE_CLASSES,
  PROVENANCE_MODES,
  TEMPORAL_CLASSES,
  arktypeStringUnion,
} from "../enums.ts";

export const MemoryVersionStatusSchema = type(
  "'active'|'superseded'|'deprecated'|'archived'|'tombstoned'",
);
export type MemoryVersionStatus = typeof MemoryVersionStatusSchema.infer;

export const CreatedByKindSchema = type("'human'|'agent'|'system'|'adapter'");
export type CreatedByKind = typeof CreatedByKindSchema.infer;

export const LineageClassSchema = type(
  arktypeStringUnion(LINEAGE_CLASSES) as "'native'|'imported'|'derived'",
);
export type LineageClass = typeof LineageClassSchema.infer;

export const ProvenanceModeSchema = type(
  arktypeStringUnion(PROVENANCE_MODES) as "'stated'|'inferred'|'unknown'",
);
export type ProvenanceMode = typeof ProvenanceModeSchema.infer;

export const TemporalClassSchema = type(
  arktypeStringUnion(TEMPORAL_CLASSES) as
    "'event'|'deadline'|'state'|'lesson'",
);
export type TemporalClass = typeof TemporalClassSchema.infer;

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
// occurred_at is effective time the content refers to (event time / state
// effective time / deadline establishment). ingested_at is when the plane
// learned it. Validity window is optional (deadline/state claims).
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
  provenance: ProvenanceModeSchema,
  source_class: LineageClassSchema,
  temporal_class: TemporalClassSchema,
  "valid_from?": "string | null",
  "valid_until?": "string | null",
});
export type MemoryVersion = typeof MemoryVersionSchema.infer;
