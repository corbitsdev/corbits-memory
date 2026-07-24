import { type } from "arktype";
import { CreatedByKindSchema, type CreatedByKind } from "./schemas/document.ts";

// Corroboration-based authority weighting: retrieval ranks by how corroborated
// a source is, not lexical relevance alone. `source_class` is the coarse bucket
// for how corroborated a source's origin typically is; kept in lockstep with
// the equivalent DB-layer enum (there is no shared package the DB layer imports
// enums from, same precedent as `CreatedByKindSchema`).
export const AuthoritySourceClassSchema = type(
  "'native'|'thread'|'channel'|'call'|'record'",
);
export type AuthoritySourceClass = typeof AuthoritySourceClassSchema.infer;

// The raw, adapter-supplied signals a version's authority is derived from.
// Every W0 adapter sets what it knows; anything it cannot observe defaults at
// the capture service (actorCount 1, hasSocialSignal false, sourceClass
// "native").
export const AuthoritySignalsSchema = type({
  createdByKind: CreatedByKindSchema,
  actorCount: "number",
  sourceClass: AuthoritySourceClassSchema,
  hasSocialSignal: "boolean",
});
export type AuthoritySignals = typeof AuthoritySignalsSchema.infer;

// Prior for WHO created the version. Human authorship is the strongest
// direct-authority signal (a person asserted this themselves); an agent
// summary is a step removed (synthesized, not directly asserted) but still
// carries real signal; system-derived content (e.g. a workflow-run record)
// is lower still; adapter-mirrored content is a mechanical copy of a raw
// source with no synthesis or assertion behind it, the weakest prior.
const CREATED_BY_KIND_PRIOR: Record<CreatedByKind, number> = {
  human: 1.0,
  agent: 0.6,
  system: 0.4,
  adapter: 0.3,
};

// Prior for the ORIGINATING SOURCE's typical corroboration potential.
// channel: a persistent, multi-party space — the highest ceiling for
// independent corroboration. thread: multi-party but bounded/ephemeral —
// still multi-party, slightly lower ceiling than a channel. call: multi-party
// and synchronous, but transient (nothing to re-corroborate after the fact).
// native: a first-class product object (artifact/task), usually single-
// authored even though the product itself is trusted. record: log/metadata-
// heavy with little editorial intent (a workflow-run's terminal summary),
// the lowest prior.
const SOURCE_CLASS_PRIOR: Record<AuthoritySourceClass, number> = {
  channel: 1.0,
  thread: 0.8,
  call: 0.7,
  native: 0.4,
  record: 0.3,
};

// Corroboration from distinct participants is log-scaled, not linear: going
// from 1 -> 2 actors is a much bigger corroboration jump than 7 -> 8. The cap
// is where marginal corroboration value is judged to plateau — a document
// with 8+ independent contributors is already about as authoritative on this
// axis as one gets, so actorScore saturates at 1.0 there rather than growing
// unbounded with actorCount.
const ACTOR_COUNT_LOG_CAP = 8;

// Weights sum to 1.0 so a perfect score on every axis produces authority ===
// 1.0 exactly. Kind/actors/source are weighted equally (0.3 each) as the
// three independent axes of "was this corroborated/asserted with authority";
// the social bump is a smaller (0.1) additive nudge — no current W0 source
// sets it, so it must not dominate the score when it does become available.
const WEIGHT_CREATED_BY_KIND = 0.3;
const WEIGHT_ACTOR_COUNT = 0.3;
const WEIGHT_SOURCE_CLASS = 0.3;
const WEIGHT_SOCIAL_SIGNAL = 0.1;

// Pure: combines the four signals additively into a 0..1 authority score.
// Recency is deliberately NOT a factor here — it is applied as a separate
// rank prior at search time (hybrid-search.ts) so an old-but-authoritative
// document and a fresh-but-unauthoritative one can each be reasoned about
// independently.
export function computeAuthority(signals: AuthoritySignals): number {
  const actorCount = Math.max(1, Math.floor(signals.actorCount));
  const actorScore = Math.min(
    Math.log(actorCount) / Math.log(ACTOR_COUNT_LOG_CAP),
    1,
  );
  const kindScore = CREATED_BY_KIND_PRIOR[signals.createdByKind];
  const sourceScore = SOURCE_CLASS_PRIOR[signals.sourceClass];
  const socialScore = signals.hasSocialSignal ? 1 : 0;

  const authority =
    WEIGHT_CREATED_BY_KIND * kindScore +
    WEIGHT_ACTOR_COUNT * actorScore +
    WEIGHT_SOURCE_CLASS * sourceScore +
    WEIGHT_SOCIAL_SIGNAL * socialScore;

  return Math.min(Math.max(authority, 0), 1);
}
