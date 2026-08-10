// Pure retrieval-fusion pieces shared by the hybrid search service. No I/O
// here (the package stays framework/DB-agnostic); the caller composes these
// with a real Postgres pool.

// Overfetch factor applied per channel (lexical, dense) before fusion so ACL
// filtering and per-document dedupe never starve the final `k` results.
export const OVERFETCH_MULTIPLIER_MIN = 3;
export const OVERFETCH_MULTIPLIER_MAX = 10;
export const DEFAULT_OVERFETCH_MULTIPLIER = 5;

// Reciprocal Rank Fusion constant. 60 is the standard value from the original
// RRF paper (Cormack et al.) and is not tuned per deployment.
export const RRF_K_DEFAULT = 60;

export const MAX_BATCH_QUERIES = 5;

export type DegradeFlag =
  | "dense_unavailable"
  | "rerank_unavailable"
  | "rerank_query_too_long"
  | "live_timeout"
  | "live_error"
  | "memory_unavailable";

export interface RankedCandidate {
  /** Stable identifier the candidate is keyed by across channels (a chunk id). */
  chunkId: string;
  /** 1-based rank within this channel's own ordered list (1 = best). */
  rank: number;
}

export interface FusedCandidate {
  chunkId: string;
  score: number;
}

// Converts an already-ranked (best-first) list of ids into RRF-ready
// candidates. A pure convenience — callers that already have per-row ranks
// (e.g. ts_rank position) may skip this and build RankedCandidate[] directly.
export function toRankedCandidates(
  orderedChunkIds: readonly string[],
): RankedCandidate[] {
  return orderedChunkIds.map((chunkId, index) => ({
    chunkId,
    rank: index + 1,
  }));
}

// Reciprocal Rank Fusion: score(chunk) = sum over channels of 1/(rrfK + rank).
// Never averages raw per-channel scores — lexical (ts_rank) and dense
// (cosine similarity) live on incomparable scales, so combining by rank
// position (not score magnitude) is the only sound fusion here (per
// `embeddings-rerank.md` §3's explicit rule). Returns candidates sorted
// descending by fused score; ties are left in fusion-encounter order
// (callers needing a further tiebreak, e.g. recency, apply it themselves).
//
// This is exactly why filtering each channel's candidates independently
// BEFORE they reach this function (kinds/entityIds in services/search.ts)
// never distorts relevance: a chunk's score here depends only on its OWN
// rank within each channel's surviving list, never on how many candidates
// survived or what fraction of the original pool they represent. Removing
// non-matching candidates upstream renumbers ranks but preserves each
// survivor's relative order, which is all RRF ever reads. A score-blending
// fusion would NOT have this property — removing candidates would shift
// score distributions (min/max, density) that a blend depends on — so this
// safety does not generalize past rank-based fusion.
export function fuseRrf(
  channels: readonly (readonly RankedCandidate[])[],
  rrfK: number = RRF_K_DEFAULT,
): FusedCandidate[] {
  const scores = new Map<string, number>();
  for (const channel of channels) {
    for (const { chunkId, rank } of channel) {
      const contribution = 1 / (rrfK + rank);
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + contribution);
    }
  }
  return [...scores.entries()]
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score);
}

// The batch `queries[]` request variant (retrieval-api.md §2.1) is bounded to
// 5 sub-queries — this is the context-card composer's internal fan-out limit,
// not a chat-agent concurrency mechanism (chat agents issue N parallel
// `search_company_knowledge` tool calls instead).
export function isBatchQueriesWithinBound(queries: readonly string[]): boolean {
  return queries.length > 0 && queries.length <= MAX_BATCH_QUERIES;
}

export function clampOverfetchMultiplier(multiplier: number): number {
  return Math.min(
    Math.max(multiplier, OVERFETCH_MULTIPLIER_MIN),
    OVERFETCH_MULTIPLIER_MAX,
  );
}

// RERANK PIPELINE DECISION (ISSUES-LOG.md) — post-rerank boost stage. The
// active-stage score (rerank score when reranked, else the fused RRF score
// on the degraded/fallback path) is normalized to [0,1] within the current
// batch, THEN multiplied by bounded authority/recency priors. Boosts are
// NEVER blended into raw fusion or reranker logit space — a multiplier
// clamped to [0.7, 1.3] can nudge the normalized score by at most ±30%,
// never let a weak match outrank a strong one on boosts alone.
export const BOOST_MULTIPLIER_MIN = 0.7;
export const BOOST_MULTIPLIER_MAX = 1.3;

// Both boost formulas share the same span: base 0.7 (worst case) + up to
// 0.6 more (best case) = 1.3 (best case ceiling), matching the locked
// [0.7, 1.3] bound exactly at the formula's own extremes — `clampBoostMultiplier`
// is defense-in-depth, not the primary bound.
const BOOST_BASE = 0.7;
const BOOST_SPAN = 0.6;

export function clampBoostMultiplier(multiplier: number): number {
  return Math.min(
    Math.max(multiplier, BOOST_MULTIPLIER_MIN),
    BOOST_MULTIPLIER_MAX,
  );
}

// Min-max normalizes a batch of scores to [0,1]. A degenerate batch (every
// score identical, including the single-item case) normalizes to 1 for
// every item — there is no basis to rank them apart, and 1 keeps their
// boost multipliers meaningful rather than collapsing everything to 0.
export function normalizeScoresToUnit(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return scores.map(() => 1);
  return scores.map((score) => (score - min) / (max - min));
}

// Authority is already a 0..1 score (computeAuthority, authority.ts) — this
// is a DIFFERENT application of it than a pre-rerank authority-weighted prior
// on raw relevance for the non-reranked path: this one is a bounded
// [0.7, 1.3] multiplier on a normalized post-rerank score, used ONLY when
// reranking is active, so authority is never applied twice.
export function authorityBoostMultiplier(authority: number): number {
  return clampBoostMultiplier(BOOST_BASE + BOOST_SPAN * authority);
}

// 30-day half-life: a document half as old as this loses half its recency
// boost span. Chosen as a working GTM-knowledge default (call/thread content
// is markedly less useful after a month) — documented as tunable, not a
// locked answer, same precedent as the authority evidence floor.
export const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export function recencyBoostMultiplier(
  occurredAt: Date,
  now: Date,
  halfLifeMs: number = RECENCY_HALF_LIFE_MS,
): number {
  const ageMs = Math.max(0, now.getTime() - occurredAt.getTime());
  const decay = Math.pow(2, -ageMs / halfLifeMs);
  return clampBoostMultiplier(BOOST_BASE + BOOST_SPAN * decay);
}

// How far ahead of valid_until a deadline starts ramping urgency (neutral
// before this window; approaches the boost ceiling at the deadline).
export const DEADLINE_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;

export type TemporalRecencyInput = {
  temporalClass: "event" | "deadline" | "state" | "lesson";
  occurredAt: Date;
  validUntil: Date | null;
  now: Date;
  halfLifeMs?: number;
};

/**
 * Recency prior by temporal class (docs/TEMPORAL.md):
 * - event: exponential decay from occurred_at (existing half-life)
 * - deadline: neutral far out; urgency ramp in lookahead before valid_until;
 *   floor after expiry (still history-retrievable, not deleted)
 * - state / lesson: no decay while active (superseded rows are status-filtered)
 */
export function temporalRecencyMultiplier(input: TemporalRecencyInput): number {
  const halfLifeMs = input.halfLifeMs ?? RECENCY_HALF_LIFE_MS;
  switch (input.temporalClass) {
    case "event":
      return recencyBoostMultiplier(input.occurredAt, input.now, halfLifeMs);
    case "state":
    case "lesson":
      return 1.0;
    case "deadline": {
      if (input.validUntil === null) return 1.0;
      const remaining = input.validUntil.getTime() - input.now.getTime();
      if (remaining <= 0) return BOOST_MULTIPLIER_MIN;
      if (remaining >= DEADLINE_LOOKAHEAD_MS) return 1.0;
      const urgency = 1 - remaining / DEADLINE_LOOKAHEAD_MS;
      return clampBoostMultiplier(1.0 + BOOST_SPAN * urgency * 0.5);
    }
  }
}
