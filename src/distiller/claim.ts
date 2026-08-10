import { RESIDENT_DISTILLER_AGENT_ID } from "./constants.ts";

/**
 * Wire body fragment for a distilled claim write (memory_add / HTTP add).
 * Access tags must be ≤ source entry tags — never widen.
 */
export type DistilledClaimWrite = {
  title: string;
  text: string;
  access_tags: string[];
  generator_agent_id: string;
  provenance: "inferred";
  lineage_class: "derived";
  derived_from: string[];
  kind?: string;
  temporal_class?: "event" | "deadline" | "state" | "lesson";
  valid_from?: string;
  valid_until?: string;
};

export type BuildDistilledClaimArgs = {
  title: string;
  text: string;
  /** Source feed entry access tags (copied, not widened). */
  sourceAccessTags: readonly string[];
  /** Source version id(s) this claim is derived from. */
  derivedFromVersionIds: readonly string[];
  generatorAgentId?: string;
  kind?: string;
  temporalClass?: "event" | "deadline" | "state" | "lesson";
  validFrom?: string;
  validUntil?: string;
};

/** Build a claim write body with loop-safe generator id and derived lineage. */
export function buildDistilledClaim(
  args: BuildDistilledClaimArgs,
): DistilledClaimWrite {
  const claim: DistilledClaimWrite = {
    title: args.title,
    text: args.text,
    access_tags: [...args.sourceAccessTags],
    generator_agent_id: args.generatorAgentId ?? RESIDENT_DISTILLER_AGENT_ID,
    provenance: "inferred",
    lineage_class: "derived",
    derived_from: [...args.derivedFromVersionIds],
  };
  if (args.kind !== undefined) claim.kind = args.kind;
  if (args.temporalClass !== undefined) {
    claim.temporal_class = args.temporalClass;
  }
  if (args.validFrom !== undefined) claim.valid_from = args.validFrom;
  if (args.validUntil !== undefined) claim.valid_until = args.validUntil;
  return claim;
}

export type FeedEntryLike = {
  versionId: string;
  generatorAgentId?: string | null;
  kind?: string;
  title?: string;
  accessTags?: readonly string[];
};

/**
 * Gate: skip own writes (defense in depth — feed excludeGenerator is primary).
 * Host policy can wrap this for kind/action-authority filters.
 */
export function shouldProcessFeedEntry(
  entry: FeedEntryLike,
  generatorAgentId: string = RESIDENT_DISTILLER_AGENT_ID,
): boolean {
  if (entry.generatorAgentId === generatorAgentId) return false;
  return true;
}

/**
 * Cursor advance: after processing a page, store nextCursor only when the
 * host finished handling (including fail-soft poison quarantine).
 * Pure helper — no I/O.
 */
export function resolveNextCursor(
  page: { nextCursor: number | null },
  opts?: { poison?: boolean },
): number | null {
  // Fail-soft: still advance so a poison entry cannot block the feed forever.
  if (opts?.poison) return page.nextCursor;
  return page.nextCursor;
}
