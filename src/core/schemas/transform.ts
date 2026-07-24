import { type } from "arktype";

// The config-driven replay pipeline. A `transform_config` pins the
// exact derivation knobs (chunking, embedding, and retrieval tuning) a
// `transform_run` re-derives the corpus under; only `token.recursive` exists
// as a chunk strategy today (adapt-and-plan.ts's only chunker), so it is the
// only literal accepted here.
export const TransformChunkParamsSchema = type({
  strategy: "'token.recursive'",
  "maxTokens?": "number",
  "minTokens?": "number",
  "overlapTokens?": "number",
});
export type TransformChunkParams = typeof TransformChunkParamsSchema.infer;

// A partial, fully-optional override of the engine's own embed endpoint.
// Every field a replay omits inherits the engine's embed config (transform.ts
// buildEmbedClientConfig merges the two) — so the common replays (a new model,
// a different endpoint, a context-window / chunking change, any tuning tweak)
// name only what changes. An embed endpoint is just a URL + capability options,
// trusted the same as the engine's own endpoint whether it is self-hosted or a
// managed provider — there is no self-host flag on the wire or anywhere else.
export const TransformEmbedParamsSchema = type({
  "baseUrl?": "string",
  "model?": "string",
  "apiStyle?": "'openai'|'tei'|'ollama'",
  "apiKey?": "string",
});
export type TransformEmbedParams = typeof TransformEmbedParamsSchema.infer;

// Mirrors RerankClientConfigSchema (rerank-client.ts); apiStyle defaults to
// 'tei' when omitted, matching the engine's own rerank config precedent
// (EngineConfig.rerank carries no apiStyle field either).
export const TransformRerankParamsSchema = type({
  "baseUrl?": "string",
  "model?": "string",
  "apiStyle?": "'tei'|'cohere'|'voyage'",
});
export type TransformRerankParams = typeof TransformRerankParamsSchema.infer;

export const TransformConfigParamsSchema = type({
  chunk: TransformChunkParamsSchema,
  "embed?": TransformEmbedParamsSchema,
  "rerank?": TransformRerankParamsSchema,
  "authorityWeight?": "number",
  "recencyHalfLifeDays?": "number",
  "mmrLambda?": "number",
  "overfetch?": "number",
});
export type TransformConfigParams = typeof TransformConfigParamsSchema.infer;

// Optional filters over raw_capture rows a replay draws from; an empty scope
// is a full backfill of every raw_capture row for the tenant. since/until
// bound raw_capture.fetched_at — validated as ISO 8601 here so a malformed
// bound fails as a 400 rather than a 500 when `new Date(since)` is invalid.
export const TransformScopeSchema = type({
  "adapter?": "string",
  "since?": "string.date.iso",
  "until?": "string.date.iso",
});
export type TransformScope = typeof TransformScopeSchema.infer;

export const CreateTransformConfigRequestSchema = type({
  tenant_id: "string",
  name: "string",
  params: TransformConfigParamsSchema,
});
export type CreateTransformConfigRequest =
  typeof CreateTransformConfigRequestSchema.infer;

export const ReplayRequestSchema = type({
  config_id: "string",
  "scope?": TransformScopeSchema,
});
export type ReplayRequest = typeof ReplayRequestSchema.infer;

export const TransformRunStatusSchema = type(
  "'running'|'completed'|'failed'",
);
export type TransformRunStatus = typeof TransformRunStatusSchema.infer;
