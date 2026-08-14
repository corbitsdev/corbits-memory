import { type } from "arktype";
import {
  CreatedByKindSchema,
  LineageClassSchema,
  MemoryVersionStatusSchema,
  ProvenanceModeSchema,
  TemporalClassSchema,
} from "./document.ts";

// The retrieval contract locked on day one. A SearchHit always pins a
// version_id (a citation must be reproducible against the exact version it
// was drawn from); "open" carries how a client can jump to the source, with
// an optional time/page anchor.
export const SearchChannelSchema = type("'lexical'|'dense'|'structured'");
export type SearchChannel = typeof SearchChannelSchema.infer;

export const SearchHitOpenSchema = type({
  type: "string",
  id: "string",
  "url?": "string",
  "at?": {
    "tSec?": "number",
    "page?": "number",
  },
});
export type SearchHitOpen = typeof SearchHitOpenSchema.infer;

export const SearchHitCitationSchema = type({
  adapter: "string",
  external_ref: "string",
  open: SearchHitOpenSchema,
});
export type SearchHitCitation = typeof SearchHitCitationSchema.infer;

export const SearchHitSchema = type({
  chunk_id: "string",
  document_id: "string",
  version: "number",
  version_id: "string",
  status: MemoryVersionStatusSchema,
  score: "number",
  title: "string",
  snippet: "string",
  kind: "string",
  created_by_kind: CreatedByKindSchema,
  "generator_agent_id?": "string",
  citation: SearchHitCitationSchema,
  entity_ids: "string[]",
  channels_matched: SearchChannelSchema.array(),
  // Additive attribution (CL-5870) — optional so older fixtures still parse.
  "provenance?": ProvenanceModeSchema,
  "source_class?": LineageClassSchema,
  "temporal_class?": TemporalClassSchema,
  "occurred_at?": "string",
  "valid_until?": "string | null",
  "supports?": "number.integer >= 0",
  "contradicts?": "number.integer >= 0",
  "derived_from?": "string[]",
});
export type SearchHit = typeof SearchHitSchema.infer;

export const SearchEvidenceSchema = type("'strong'|'weak'|'none'");
export type SearchEvidence = typeof SearchEvidenceSchema.infer;

export const SearchDegradedReasonSchema = type(
  "'dense_unavailable'|'rerank_unavailable'|'lexical_only'",
);
export type SearchDegradedReason = typeof SearchDegradedReasonSchema.infer;

// evidence is derived from hit count + score threshold downstream.
export const SearchResponseSchema = type({
  hits: SearchHitSchema.array(),
  evidence: SearchEvidenceSchema,
  "degraded?": SearchDegradedReasonSchema.array(),
});
export type SearchResponse = typeof SearchResponseSchema.infer;
