import { type } from "arktype";
import { CreatedByKindSchema, VisibilitySpecSchema } from "./document.ts";
import { KnowledgeEdgeHintSchema } from "./entity-edge.ts";
import { AuthoritySourceClassSchema } from "../authority.ts";

// A hint that a chunk/document mentions a real-world entity; the ingestion
// engine resolves this against knowledge_entity, creating a row if none
// matches yet.
export const EntityHintSchema = type({
  kind: "string",
  identifier: "string",
  "label?": "string",
});
export type EntityHint = typeof EntityHintSchema.infer;

export const ActorAttributionSchema = type({
  kind: CreatedByKindSchema,
  "principalId?": "string",
  "agentId?": "string",
});
export type ActorAttribution = typeof ActorAttributionSchema.infer;

// Caps on a single chunk's text length and on how many chunks a single
// capture may carry — a request-size guard independent of the global
// body-size limit (index.ts), since a payload well under that limit could
// still carry pathologically many/large chunks.
export const MAX_CHUNK_TEXT_CHARS = 100_000;
export const MAX_CHUNKS_PER_DOCUMENT = 2_000;
export const MAX_TITLE_CHARS = 500;
export const MAX_KIND_CHARS = 200;

export const AdaptedDocumentChunkSchema = type({
  ordinal: "number",
  text: `string <= ${MAX_CHUNK_TEXT_CHARS}`,
  "role?": "string",
});
export type AdaptedDocumentChunk = typeof AdaptedDocumentChunkSchema.infer;

export const RawPointerSchema = type({
  table: "string",
  id: "string",
});
export type RawPointer = typeof RawPointerSchema.infer;

// What a source adapter produces. rawPointer is a pointer to the raw
// payload's own table, never a re-store of the blob itself; contentHash is
// the NOOP key.
export const AdaptedDocumentSchema = type({
  kind: `1 <= string <= ${MAX_KIND_CHARS}`,
  title: `1 <= string <= ${MAX_TITLE_CHARS}`,
  externalRef: "string",
  visibility: VisibilitySpecSchema,
  "attributes?": "Record<string, string | number | boolean | null>",
  entityHints: EntityHintSchema.array(),
  "edges?": KnowledgeEdgeHintSchema.array(),
  chunks: AdaptedDocumentChunkSchema.array().atMostLength(MAX_CHUNKS_PER_DOCUMENT),
  "rawPointer?": RawPointerSchema,
  "actor?": ActorAttributionSchema,
  // The raw authority signals a caller can observe. All three are optional: a
  // caller that cannot observe a signal omits it, and the capture service fills
  // the documented default (actorCount 1, sourceClass "native", hasSocialSignal
  // false) before computeAuthority runs.
  "actorCount?": "number",
  "sourceClass?": AuthoritySourceClassSchema,
  "hasSocialSignal?": "boolean",
  contentHash: "string",
});
export type AdaptedDocument = typeof AdaptedDocumentSchema.infer;
