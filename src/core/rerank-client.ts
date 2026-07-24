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
      body: JSON.stringify({ query, texts: docs.map((d) => d.text) }),
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
