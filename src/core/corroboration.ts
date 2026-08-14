/**
 * Living claim relevancy from supports/contradicts edge counts.
 *
 * Capture-time `authority` stays a frozen snapshot. Search multiplies ranking
 * by a bounded corroboration factor derived from graph edges (version targets).
 * Core never decides claim sameness — the distiller chooses supports vs new write.
 *
 * See docs/RELEVANCY.md.
 */
import {
  BOOST_MULTIPLIER_MAX,
  BOOST_MULTIPLIER_MIN,
  clampBoostMultiplier,
} from "./hybrid-search.ts";

/** Independent supports needed for evidence:strong (with authority floor). */
export const CORROBORATION_STRONG_FLOOR = 2;

/** Log-scale cap for support/contradict counts (mirrors actor-count plateau). */
export const CORROBORATION_COUNT_LOG_CAP = 4;

const BOOST_BASE = BOOST_MULTIPLIER_MIN;
const BOOST_SPAN = BOOST_MULTIPLIER_MAX - BOOST_MULTIPLIER_MIN;

export type CorroborationCounts = {
  supports: number;
  contradicts: number;
};

/**
 * Bounded multiplier in [0.7, 1.3]. Neutral (1.0) when no edges.
 * Supports raise rank; contradicts lower it — never auto-delete.
 */
export function corroborationFactor(counts: CorroborationCounts): number {
  const supports = Math.max(0, Math.floor(counts.supports));
  const contradicts = Math.max(0, Math.floor(counts.contradicts));
  if (supports === 0 && contradicts === 0) {
    return 1;
  }
  const denom = Math.log(1 + CORROBORATION_COUNT_LOG_CAP);
  const supportScore =
    denom > 0 ? Math.min(1, Math.log(1 + supports) / denom) : 0;
  const contradictScore =
    denom > 0 ? Math.min(1, Math.log(1 + contradicts) / denom) : 0;
  // Midpoint 0.5 + half support − half contradict → [0, 1] then map to envelope.
  const unit = Math.min(
    1,
    Math.max(0, 0.5 + 0.5 * supportScore - 0.5 * contradictScore),
  );
  return clampBoostMultiplier(BOOST_BASE + BOOST_SPAN * unit);
}

/**
 * Effective authority for ranking: snapshot × corroboration factor, clamped to
 * [0, 1] so authority-weighted formulas stay in range.
 */
export function effectiveAuthority(
  captureAuthority: number,
  counts: CorroborationCounts,
): number {
  const factor = corroborationFactor(counts);
  return Math.min(1, Math.max(0, captureAuthority * factor));
}

export type StrongEvidenceSignals = {
  /** Capture-time authority (0..1). */
  authority: number;
  /** Independent supports targeting this version. */
  supports: number;
  provenance?: string | undefined;
  createdByKind?: string | undefined;
  /** Default AUTHORITY_STRONG_FLOOR from search. */
  authorityFloor: number;
  corroborationFloor?: number | undefined;
};

/**
 * Whether evidence may report strong given relevance already cleared.
 * Requires authority floor AND (stated human OR supports ≥ floor).
 */
export function meetsStrongEvidenceGate(signals: StrongEvidenceSignals): boolean {
  if (signals.authority < signals.authorityFloor) return false;
  const floor = signals.corroborationFloor ?? CORROBORATION_STRONG_FLOOR;
  const statedHuman =
    signals.provenance === "stated" && signals.createdByKind === "human";
  if (statedHuman) return true;
  return Math.max(0, Math.floor(signals.supports)) >= floor;
}
