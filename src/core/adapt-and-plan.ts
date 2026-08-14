import { DEFAULT_CHUNK_CAPS } from "./chunk/types.ts";
import { chunkTokenRecursive } from "./chunk/token-recursive.ts";
import type { Chunker } from "./chunk/types.ts";
import { contentHash } from "./hash.ts";
import type {
  AdaptedDocument,
  AdaptedDocumentChunk,
  EntityHint,
} from "./schemas/adapted-document.ts";
import type { MemoryEdgeHint } from "./schemas/entity-edge.ts";

/**
 * Thrown when an AdaptedDocument fails adaptAndPlan's own defensive checks
 * (empty title/kind). The wire boundary (AdaptedDocumentSchema's
 * `minLength: 1` on title/kind) already rejects this with a 400 before
 * adaptAndPlan ever runs, so this is defense-in-depth for any caller that
 * builds an AdaptedDocument without going through that schema — adaptAndPlan
 * itself never swallows the error, that is the caller's job.
 */
export class InvalidAdaptedDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAdaptedDocumentError";
  }
}

export type CapturePlanChunk = AdaptedDocumentChunk & {
  tokenCount: number;
  span: { start: number; end: number };
};

// The pure output of adapting+planning a capture: the final cap-enforced
// chunk list (with span offsets for citations), the entity/edge upserts
// carried through from the caller, and the NOOP-check content hash.
export type CapturePlan = {
  document: AdaptedDocument;
  contentHash: string;
  chunks: CapturePlanChunk[];
  entityHints: EntityHint[];
  edges: MemoryEdgeHint[];
};

export type AdaptAndPlanOptions = {
  /** Injected chunker port — defaults to the token-recursive fallback. */
  chunker?: Chunker;
};

function rechunk(
  chunks: AdaptedDocumentChunk[],
  chunker: Chunker,
): CapturePlanChunk[] {
  const planChunks: CapturePlanChunk[] = [];
  let ordinal = 0;
  for (const chunk of chunks) {
    const pieces = chunker(chunk.text, DEFAULT_CHUNK_CAPS);
    for (const piece of pieces) {
      planChunks.push({
        ordinal: ordinal++,
        text: piece.text,
        ...(chunk.role !== undefined ? { role: chunk.role } : {}),
        tokenCount: piece.tokenCount,
        span: piece.span,
      });
    }
  }
  return planChunks;
}

/**
 * Turns an already-adapted document (the caller's capture payload) into a
 * capture plan: chunk list (via the chunker port, default
 * `chunkTokenRecursive`), entity/edge upserts, and a stable content hash.
 * Pure — no I/O, no DB, no LLM calls.
 */
export function adaptAndPlan(
  adapted: AdaptedDocument,
  opts: AdaptAndPlanOptions = {},
): CapturePlan {
  if (adapted.title.trim().length === 0) {
    throw new InvalidAdaptedDocumentError(
      "AdaptedDocument.title must not be empty",
    );
  }
  if (adapted.kind.trim().length === 0) {
    throw new InvalidAdaptedDocumentError(
      "AdaptedDocument.kind must not be empty",
    );
  }

  const chunker = opts.chunker ?? chunkTokenRecursive;
  const chunks = rechunk(adapted.chunks, chunker);
  const attributes = adapted.attributes ?? {};

  return {
    document: adapted,
    contentHash: contentHash({
      title: adapted.title,
      kind: adapted.kind,
      externalRef: adapted.externalRef,
      attributes,
      chunkTexts: chunks.map((chunk) => chunk.text),
    }),
    chunks,
    entityHints: adapted.entityHints,
    edges: adapted.edges ?? [],
  };
}
