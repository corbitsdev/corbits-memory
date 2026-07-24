import { type } from "arktype";

// Owner-plugged embed client — talks to any OpenAI-compatible endpoint, a
// Text Embeddings Inference (TEI) server, or a self-hosted Ollama instance.
// `apiKey` is an already-resolved secret string: resolving it from the
// tenant credential store is the CALLER's job. A `baseUrl` is just a trusted
// URL, the same as `KNOWLEDGE_DATABASE_URL` — self-hosted or managed makes no
// difference, and there is no self-host flag anywhere.
export const EmbedClientConfigSchema = type({
  baseUrl: "string",
  modelId: "string",
  "apiKey?": "string",
  apiStyle: "'openai'|'tei'|'ollama'",
  "timeoutMs?": "number",
  "batchSize?": "number",
});
export type EmbedClientConfig = typeof EmbedClientConfigSchema.infer;

export class EmbedTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedTimeoutError";
  }
}

export class EmbedHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodySnippet: string,
    public readonly url?: string,
  ) {
    super(
      `Embed endpoint returned HTTP ${status}${url ? ` for ${url}` : ""}: ${bodySnippet}`,
    );
    this.name = "EmbedHttpError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_SIZE = 32;
const PROBE_TEXT = "embedding dimension probe";

function buildHeaders(config: EmbedClientConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function chunkTexts(
  texts: readonly string[],
  size: number,
): (readonly string[])[] {
  const out: (readonly string[])[] = [];
  for (let i = 0; i < texts.length; i += size) {
    out.push(texts.slice(i, i + size));
  }
  return out;
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
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new EmbedTimeoutError(
        `Embed request to ${url} timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  }
  return res;
}

async function assertOk(res: Response, url: string): Promise<void> {
  if (res.ok) return;
  const bodySnippet = (await res.text().catch(() => "")).slice(0, 500);
  throw new EmbedHttpError(res.status, bodySnippet, url);
}

async function embedBatchOpenAi(
  batch: readonly string[],
  config: EmbedClientConfig,
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  const url = `${config.baseUrl}/v1/embeddings`;
  const res = await doFetch(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify({ model: config.modelId, input: batch }),
    },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  await assertOk(res, url);
  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  if (!json.data) {
    throw new EmbedHttpError(res.status, "openai-compat response missing data[]", url);
  }
  return json.data.map((d) => d.embedding);
}

async function embedBatchTei(
  batch: readonly string[],
  config: EmbedClientConfig,
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  const url = `${config.baseUrl}/embed`;
  const res = await doFetch(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify({ inputs: batch }),
    },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  await assertOk(res, url);
  return (await res.json()) as number[][];
}

// Ollama's current `/api/embed` shape takes `{ model, input: string[] }` and
// returns `{ embeddings: number[][] }`, with `truncate` defaulting to true so
// an over-long input is clipped to the model's context rather than 500ing (the
// older singular `/api/embeddings` + `prompt` endpoint errors instead).
async function embedBatchOllama(
  batch: readonly string[],
  config: EmbedClientConfig,
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  const url = `${config.baseUrl}/api/embed`;
  const res = await doFetch(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.modelId,
        input: [...batch],
        truncate: true,
      }),
    },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  await assertOk(res, url);
  const json = (await res.json()) as { embeddings?: number[][] };
  if (!json.embeddings || json.embeddings.length !== batch.length) {
    throw new EmbedHttpError(
      res.status,
      "ollama response missing or mismatched embeddings field",
      url,
    );
  }
  return json.embeddings;
}

async function embedBatch(
  batch: readonly string[],
  config: EmbedClientConfig,
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  if (config.apiStyle === "openai") return embedBatchOpenAi(batch, config, fetchImpl);
  if (config.apiStyle === "tei") return embedBatchTei(batch, config, fetchImpl);
  return embedBatchOllama(batch, config, fetchImpl);
}

export async function embedTexts(
  texts: readonly string[],
  config: EmbedClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const vectors: number[][] = [];
  for (const batch of chunkTexts(texts, batchSize)) {
    vectors.push(...(await embedBatch(batch, config, fetchImpl)));
  }
  return vectors;
}

// The single dims-discovery mechanism shared by the registry's activation
// path (embed-model-registry.ts) and the settings UI's Test button — import
// this one, never re-derive dims elsewhere.
export async function probeEmbedDims(
  config: EmbedClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const [vector] = await embedTexts([PROBE_TEXT], config, fetchImpl);
  if (!vector) {
    throw new Error("Embed probe returned no vector");
  }
  return vector.length;
}
