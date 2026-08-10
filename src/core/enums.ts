// Single source of truth for memory-plane enums that also appear as
// Postgres CHECK constraints. Arktype schemas import these; the lockstep
// test asserts the latest migration SQL matches exactly.

/** Graph edge relationship kinds stored on memory.edge.rel. */
export const EDGE_RELS = [
  "mentions",
  "about",
  "authored_by",
  "involves",
  "part_of",
  "derived_from",
  "supports",
  "contradicts",
  "supersedes",
] as const;
export type EdgeRel = (typeof EDGE_RELS)[number];

/**
 * Endpoint kinds that may be written to memory.edge.from_type / to_type.
 * Adapter-facing hints may also use `native` (see EDGE_REF_TYPES_ADAPTER);
 * capture resolves native → entity before insert.
 */
export const EDGE_REF_TYPES_DB = [
  "document",
  "version",
  "chunk",
  "entity",
] as const;
export type EdgeRefTypeDb = (typeof EDGE_REF_TYPES_DB)[number];

/** Adapter-facing edge endpoint kinds, including planning-time `native`. */
export const EDGE_REF_TYPES_ADAPTER = [
  ...EDGE_REF_TYPES_DB,
  "native",
] as const;
export type EdgeRefTypeAdapter = (typeof EDGE_REF_TYPES_ADAPTER)[number];

/**
 * Data-lineage class stored on memory.version.source_class.
 * Orthogonal to AuthoritySourceClass (ranking priors: thread/channel/…).
 */
export const LINEAGE_CLASSES = ["native", "imported", "derived"] as const;
export type LineageClass = (typeof LINEAGE_CLASSES)[number];

/**
 * How the version's content was obtained relative to assertion.
 * Orthogonal to created_by_kind (who) and lineageClass (where from).
 */
export const PROVENANCE_MODES = ["stated", "inferred", "unknown"] as const;
export type ProvenanceMode = (typeof PROVENANCE_MODES)[number];

/**
 * Temporal ranking class stored on memory.version.temporal_class.
 * See docs/TEMPORAL.md.
 */
export const TEMPORAL_CLASSES = [
  "event",
  "deadline",
  "state",
  "lesson",
] as const;
export type TemporalClass = (typeof TEMPORAL_CLASSES)[number];

/**
 * Retention class on memory.version.retention_class (CL-5871).
 * Orthogonal to temporal_class (ranking) and status (lifecycle).
 */
export const RETENTION_CLASSES = [
  "durable",
  "standard",
  "ephemeral",
  "source_only",
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Build an arktype union string from a const string array. */
export function arktypeStringUnion(
  values: readonly string[],
): string {
  return values.map((v) => `'${v}'`).join("|");
}
