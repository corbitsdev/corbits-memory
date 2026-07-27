import { type } from "arktype";

// RERANK PIPELINE DECISION (ISSUES-LOG.md) — owner-plugged HTTP rerank
// client, mirroring embed-client.ts's shape: any TEI-compatible
// cross-encoder server, or a hosted Cohere/Voyage rerank endpoint. Degrades
// soft everywhere it is called from (hybrid-search.ts falls back to fused
// order when this config is absent or the call fails) — a rerank outage
// must never make search fail.
export const RerankClientConfigSchema = type({
  baseUrl: "string",
  "model?": "string",
  apiStyle: "'tei'|'cohere'|'voyage'",
  "apiKey?": "string",
  "timeoutMs?": "number",
  // Per-document character budget for TEI requests — an explicit override;
  // omit to derive one from the resolved model's advertised token limit (see
  // `defaultMaxDocCharsForModel`). Ignored for cohere/voyage, which advertise
  // much longer context windows.
  "maxDocChars?": "number",
});
export type RerankClientConfig = typeof RerankClientConfigSchema.infer;

export const DEFAULT_RERANK_MODEL = "bge-reranker-v2-m3";

export interface RerankDoc {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export class RerankTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerankTimeoutError";
  }
}

// Thrown by `rerankTei` when the query alone leaves less than `MIN_DOC_CHARS`
// of the query+document budget for the document. Truncating the query
// instead would silently change what the user asked and feed the reranker a
// mangled query, which is worse than not reranking; forcing the document
// budget back up would exceed the model's vetted per-pair limit and 413.
// Skipping is the only option that keeps the request honest and within
// budget — the caller is expected to catch this the same way it catches any
// other rerank failure and fall back to fused ranking.
export class RerankQueryTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerankQueryTooLongError";
  }
}

export class RerankHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodySnippet: string,
    public readonly url?: string,
  ) {
    super(
      `Rerank endpoint returned HTTP ${status}${url ? ` for ${url}` : ""}: ${bodySnippet}`,
    );
    this.name = "RerankHttpError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

function buildHeaders(config: RerankClientConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

async function doFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  timeoutMs: number,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      throw new RerankTimeoutError(
        `Rerank request to ${url} timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  }
  return res;
}

async function assertOk(res: Response, url: string): Promise<void> {
  if (res.ok) return;
  const bodySnippet = (await res.text().catch(() => "")).slice(0, 500);
  throw new RerankHttpError(res.status, bodySnippet, url);
}

// Cross-encoders cap the query+document pair, and TEI rejects the WHOLE batch
// with a 413 if any single document is over — so one long chunk disables
// reranking for the entire query. The engine chunks at ~700 tokens, which
// already exceeds `bge-reranker-base`/`-large`'s 512-token limit.
//
// Truncating keeps reranking working at a known cost: the reranker scores the
// head of a chunk while the caller still cites and reads the whole thing, so a
// document whose relevance lives only in its tail scores lower than it should.
// Ranking the first N tokens beats not ranking at all.
//
// The budget is derived PER MODEL (`defaultMaxDocCharsForModel`), not a
// single global constant: `bge-reranker-base` (512 tokens) and
// `bge-reranker-v2-m3` (8,192 tokens, the engine's actual default — see
// `DEFAULT_RERANK_MODEL`) need very different budgets, and applying the
// smaller model's budget unconditionally silently over-truncates every
// chunk on the default model instead of fixing the 413.
//
// Conservative floor used to estimate tokens from characters, both to
// validate `maxDocChars` against a model's advertised limit and to size the
// per-request truncation budget. 3 chars/token covers ordinary
// English/code-comment prose (average is closer to 4). It is NOT a
// guarantee: dense text with a poor char-to-token ratio — CJK, minified
// code, base64, dense punctuation — can run closer to ~1 char/token and can
// still overflow the model's real limit even after this truncation. There
// is no reliable non-model-specific way to bound that without invoking the
// actual tokenizer, so this stays a documented gap, not a bug. Operators
// serving those corpora through a TEI cross-encoder should lower
// `RERANK_MAX_DOC_CHARS` well below the computed ceiling.
const CHARS_PER_TOKEN_FLOOR = 3;

// Token limits for rerankers we know are commonly TEI-served. Deliberately a
// short, high-confidence list.
export const KNOWN_TEI_RERANK_MODEL_TOKEN_LIMITS: Record<string, number> = {
  "bge-reranker-base": 512,
  "bge-reranker-large": 512,
  "bge-reranker-v2-m3": 8_192,
};

// A TEI model absent from the table above resolves to this instead of
// skipping validation/budget derivation outright — an earlier version did
// that, which meant an unrecognized (or simply unset) model validated
// nothing and fell through to a size calibrated for a different model. 512
// is the smallest limit we know of across common TEI cross-encoders
// (bge-reranker-base/-large): assuming the smallest known limit is the safe
// direction to guess wrong in, since it under-uses a model that turns out to
// support more, rather than risking a 413 on one that supports less.
// Operators who know their model's real limit should set
// `RERANK_MAX_DOC_CHARS` explicitly; `validateRerankConfig` still checks
// that override against this same fallback.
const CONSERVATIVE_FALLBACK_TOKEN_LIMIT = 512;

function resolveRerankModel(config: Pick<RerankClientConfig, "model">): string {
  return config.model ?? DEFAULT_RERANK_MODEL;
}

function tokenLimitForModel(model: string): number {
  return (
    KNOWN_TEI_RERANK_MODEL_TOKEN_LIMITS[model] ?? CONSERVATIVE_FALLBACK_TOKEN_LIMIT
  );
}

// Fixed token headroom subtracted from a model's advertised limit before
// converting to a char budget — the same margin the original
// bge-reranker-base calibration used (512 - 12 = 500 tokens -> 1500 chars).
// Kept as a flat token count rather than a percentage so it scales the same
// way regardless of the resolved model's limit.
const SAFETY_MARGIN_TOKENS = 12;

// The document character budget for a resolved TEI model, used whenever the
// config doesn't set an explicit `maxDocChars` override. Per-model, not a
// single constant — see the block comment above.
export function defaultMaxDocCharsForModel(model: string): number {
  const tokenLimit = tokenLimitForModel(model);
  return Math.max(tokenLimit - SAFETY_MARGIN_TOKENS, 0) * CHARS_PER_TOKEN_FLOOR;
}

// The default budget for the engine's own default TEI model
// (`DEFAULT_RERANK_MODEL`, bge-reranker-v2-m3) — exported for callers and
// tests that want "the real default" without re-deriving it.
export const DEFAULT_MAX_DOC_CHARS = defaultMaxDocCharsForModel(
  DEFAULT_RERANK_MODEL,
);

export class RerankConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerankConfigError";
  }
}

/**
 * Catches a chunk-size / reranker-limit mismatch at config time instead of
 * at every query (where it previously surfaced as a silent per-batch 413).
 * Resolves the model exactly as `rerankTei` does (`config.model ??
 * DEFAULT_RERANK_MODEL`) so validation runs on the model actually used, not
 * only when an operator happens to set `model` explicitly. An unrecognized
 * model is checked against `CONSERVATIVE_FALLBACK_TOKEN_LIMIT` rather than
 * skipped. Only applies to the TEI path; cohere/voyage are unchecked (see
 * `rerankCohere`/`rerankVoyage`).
 */
export function validateRerankConfig(config: RerankClientConfig): void {
  if (config.apiStyle !== "tei") return;
  const model = resolveRerankModel(config);
  const tokenLimit = tokenLimitForModel(model);
  const maxDocChars = config.maxDocChars ?? defaultMaxDocCharsForModel(model);
  const estimatedMaxTokens = Math.ceil(maxDocChars / CHARS_PER_TOKEN_FLOOR);
  if (estimatedMaxTokens > tokenLimit) {
    const knownModel = model in KNOWN_TEI_RERANK_MODEL_TOKEN_LIMITS;
    throw new RerankConfigError(
      `Rerank maxDocChars=${maxDocChars} can produce up to ~${estimatedMaxTokens} tokens per document, ` +
        `exceeding ${model}'s ${tokenLimit}-token limit` +
        `${knownModel ? "" : " (model not recognized; assumed the conservative fallback limit)"}. ` +
        `Lower maxDocChars (RERANK_MAX_DOC_CHARS) or switch to a longer-context reranker.`,
    );
  }
}

// Minimum document budget worth sending to the reranker. If a query is so
// long that it alone eats the resolved model's budget down past this floor,
// we do NOT force the document budget back up to this floor — that would
// grow the query+document pair past maxDocChars (the value
// `validateRerankConfig` vetted against the model's real token limit),
// reproducing the 413 this module exists to prevent. Instead `rerankTei`
// throws `RerankQueryTooLongError` and the caller skips reranking for that
// request, same as any other rerank failure (see hybrid-search.ts's
// `rerank_unavailable`/soft-degrade path).
const MIN_DOC_CHARS = 200;

// TEI's limit is on the query+document PAIR, not the document alone — a long
// query plus a budget-sized document can still overflow the model's cap.
// `budget` here is already resolved to the document's share of maxDocChars
// (see `resolveDocBudget`); this only truncates to it. Trims before slicing
// so a document that opens with padding whitespace doesn't yield an
// all-whitespace result once cut.
function truncateForRerank(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const trimmed = text.trim();
  return trimmed.length <= budget ? trimmed : trimmed.slice(0, budget);
}

// Splits maxDocChars between query and document. Never grows the document
// share past what's left after the query — doing so is exactly the bug this
// resolves (see `RerankQueryTooLongError`). Returns null when the query
// alone leaves less than MIN_DOC_CHARS for the document; callers must treat
// null as "skip reranking for this request", not "use MIN_DOC_CHARS anyway".
function resolveDocBudget(maxDocChars: number, queryChars: number): number | null {
  const budget = maxDocChars - queryChars;
  return budget < MIN_DOC_CHARS ? null : budget;
}

// TEI's native `/rerank` shape: `{query, texts}` -> `[{index, score}]`
// (unordered — callers must respect `index`, not array position).
async function rerankTei(
  query: string,
  docs: readonly RerankDoc[],
  config: RerankClientConfig,
  fetchImpl: typeof fetch,
): Promise<RerankResult[]> {
  const model = resolveRerankModel(config);
  const maxDocChars = config.maxDocChars ?? defaultMaxDocCharsForModel(model);
  const docBudget = resolveDocBudget(maxDocChars, query.length);
  if (docBudget === null) {
    throw new RerankQueryTooLongError(
      `query is ${query.length} chars, leaving under ${MIN_DOC_CHARS} of the ` +
        `${maxDocChars}-char maxDocChars budget for the document; skipping ` +
        `rerank rather than sending a query+document pair guaranteed to ` +
        `exceed the model's token limit`,
    );
  }

  const url = `${config.baseUrl}/rerank`;
  const res = await doFetch(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify({
        query,
        texts: docs.map((d) => truncateForRerank(d.text, docBudget)),
      }),
    },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  await assertOk(res, url);
  const json = (await res.json()) as { index: number; score: number }[];
  return json.map(({ index, score }) => {
    const doc = docs[index];
    if (!doc) {
      throw new RerankHttpError(
        res.status,
        `TEI response index ${index} out of bounds`,
        url,
      );
    }
    return { id: doc.id, score };
  });
}

// Same query+document pair-budget reasoning as TEI applies here in
// principle, but Cohere's rerank-v3.5/multilingual-v3 advertise 4,096
// tokens per document — over an order of magnitude past what our ~700-token
// chunks plus any realistic query need — so it is not enforced. This is not
// proven safe for arbitrarily large input; it's a documented judgment call
// that Cohere's context window makes the TEI failure mode impractical to
// hit at our chunk sizes, not a guarantee.
//
// Cohere v2 `/v2/rerank` shape: `{model, query, documents}` ->
// `{results: [{index, relevance_score}]}`.
async function rerankCohere(
  query: string,
  docs: readonly RerankDoc[],
  config: RerankClientConfig,
  fetchImpl: typeof fetch,
): Promise<RerankResult[]> {
  const url = `${config.baseUrl}/v2/rerank`;
  const res = await doFetch(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model ?? DEFAULT_RERANK_MODEL,
        query,
        documents: docs.map((d) => d.text),
      }),
    },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  await assertOk(res, url);
  const json = (await res.json()) as {
    results?: { index: number; relevance_score: number }[];
  };
  if (!json.results) {
    throw new RerankHttpError(
      res.status,
      "cohere response missing results[]",
      url,
    );
  }
  return json.results.map(({ index, relevance_score }) => {
    const doc = docs[index];
    if (!doc) {
      throw new RerankHttpError(
        res.status,
        `Cohere response index ${index} out of bounds`,
        url,
      );
    }
    return { id: doc.id, score: relevance_score };
  });
}

// Same reasoning as `rerankCohere` above: Voyage's rerank-2 advertises a
// 32,000-token context, so the pair-budget failure mode this module fixes
// for TEI is not enforced here either — judged impractical to hit at our
// chunk sizes, not verified safe for arbitrary input.
//
// Voyage `/v1/rerank` shape: `{model, query, documents}` ->
// `{data: [{index, relevance_score}]}`.
async function rerankVoyage(
  query: string,
  docs: readonly RerankDoc[],
  config: RerankClientConfig,
  fetchImpl: typeof fetch,
): Promise<RerankResult[]> {
  const url = `${config.baseUrl}/v1/rerank`;
  const res = await doFetch(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model ?? DEFAULT_RERANK_MODEL,
        query,
        documents: docs.map((d) => d.text),
      }),
    },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  await assertOk(res, url);
  const json = (await res.json()) as {
    data?: { index: number; relevance_score: number }[];
  };
  if (!json.data) {
    throw new RerankHttpError(
      res.status,
      "voyage response missing data[]",
      url,
    );
  }
  return json.data.map(({ index, relevance_score }) => {
    const doc = docs[index];
    if (!doc) {
      throw new RerankHttpError(
        res.status,
        `Voyage response index ${index} out of bounds`,
        url,
      );
    }
    return { id: doc.id, score: relevance_score };
  });
}

/**
 * Cross-encoder rerank over a candidate set — returns `{id, score}` sorted
 * descending by score. `docs` are the overfetched RRF-fused candidates
 * (top-50 per the locked pipeline decision); the caller decides how many to
 * send. Empty input short-circuits without a network call, same precedent as
 * `embedTexts`.
 */
export async function rerankDocuments(
  query: string,
  docs: readonly RerankDoc[],
  config: RerankClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RerankResult[]> {
  if (docs.length === 0) return [];

  let results: RerankResult[];
  if (config.apiStyle === "tei") {
    results = await rerankTei(query, docs, config, fetchImpl);
  } else if (config.apiStyle === "cohere") {
    results = await rerankCohere(query, docs, config, fetchImpl);
  } else {
    results = await rerankVoyage(query, docs, config, fetchImpl);
  }

  return results.sort((a, b) => b.score - a.score);
}
