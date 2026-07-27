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
  // Per-document character budget for TEI requests — see TEI_MAX_DOC_CHARS.
  // Ignored for cohere/voyage, which advertise much longer context windows.
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
// reranking for the entire query. The engine chunks at ~700 tokens while
// `bge-reranker-base` allows 512, which means every real chunk trips it.
//
// Truncating keeps reranking working at a known cost: the reranker scores the
// head of a chunk while the caller still cites and reads the whole thing, so a
// document whose relevance lives only in its tail scores lower than it should.
// Ranking the first ~450 tokens beats not ranking at all.
//
// Default is deliberately conservative for `bge-reranker-base` (512 tokens):
// chars-per-token varies with content, so this assumes as few as ~3
// chars/token (CHARS_PER_TOKEN_FLOOR below) to avoid overshooting —
// overshooting costs the entire batch. 1500 chars / 3 = 500 estimated
// tokens, under the 512 cap with headroom to spare; this is the largest
// round value that still clears `validateRerankConfig` against
// bge-reranker-base with the floor below (must satisfy
// ceil(value / CHARS_PER_TOKEN_FLOOR) <= 512, i.e. value <= 1536).
// `rerank-client.test.ts` asserts this constant against the real default
// model so the two can't drift apart again.
//
// Callers with a longer-context reranker (several go to 4K-32K tokens) can
// raise this via `RerankClientConfig.maxDocChars`; `validateRerankConfig`
// catches a mismatch against known models' advertised limits up front.
export const TEI_MAX_DOC_CHARS = 1_500;

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

// Always send at least this many document characters, even when a very long
// query eats most of the shared query+document budget — zero document
// content defeats reranking outright, so a long query degrades the
// truncation rather than starving the document to nothing.
const MIN_DOC_CHARS = 200;

// Token limits for rerankers we know are commonly TEI-served. Deliberately a
// short, high-confidence list: an unlisted model skips validation rather than
// asserting a limit we're not sure of.
export const KNOWN_TEI_RERANK_MODEL_TOKEN_LIMITS: Record<string, number> = {
  "bge-reranker-base": 512,
  "bge-reranker-large": 512,
};

export class RerankConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerankConfigError";
  }
}

/**
 * Catches a chunk-size / reranker-limit mismatch at config time instead of
 * at every query (where it previously surfaced as a silent per-batch 413).
 * Only validates TEI configs against a known model's advertised token limit;
 * everything else (unlisted model, cohere/voyage) is left unchecked.
 */
export function validateRerankConfig(config: RerankClientConfig): void {
  if (config.apiStyle !== "tei" || !config.model) return;
  const tokenLimit = KNOWN_TEI_RERANK_MODEL_TOKEN_LIMITS[config.model];
  if (tokenLimit === undefined) return;

  const maxDocChars = config.maxDocChars ?? TEI_MAX_DOC_CHARS;
  const estimatedMaxTokens = Math.ceil(maxDocChars / CHARS_PER_TOKEN_FLOOR);
  if (estimatedMaxTokens > tokenLimit) {
    throw new RerankConfigError(
      `Rerank maxDocChars=${maxDocChars} can produce up to ~${estimatedMaxTokens} tokens per document, ` +
        `exceeding ${config.model}'s ${tokenLimit}-token limit. Lower maxDocChars (RERANK_MAX_DOC_CHARS) ` +
        `or switch to a longer-context reranker.`,
    );
  }
}

// TEI's limit is on the query+document PAIR, not the document alone — a long
// query plus a budget-sized document can still overflow the model's cap.
// Reserve the query's estimated share of the budget first (floored at
// MIN_DOC_CHARS so the document is never truncated to nothing), then
// truncate. Trims before slicing so a document that opens with padding
// whitespace doesn't yield an all-whitespace result once cut.
function truncateForRerank(
  text: string,
  maxDocChars: number,
  queryChars: number,
): string {
  const floor = Math.min(MIN_DOC_CHARS, maxDocChars);
  const budget = Math.max(maxDocChars - queryChars, floor);
  if (text.length <= budget) return text;
  const trimmed = text.trim();
  return trimmed.length <= budget ? trimmed : trimmed.slice(0, budget);
}

// TEI's native `/rerank` shape: `{query, texts}` -> `[{index, score}]`
// (unordered — callers must respect `index`, not array position).
async function rerankTei(
  query: string,
  docs: readonly RerankDoc[],
  config: RerankClientConfig,
  fetchImpl: typeof fetch,
): Promise<RerankResult[]> {
  const url = `${config.baseUrl}/rerank`;
  const res = await doFetch(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify({
        query,
        texts: docs.map((d) =>
          truncateForRerank(
            d.text,
            config.maxDocChars ?? TEI_MAX_DOC_CHARS,
            query.length,
          ),
        ),
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
