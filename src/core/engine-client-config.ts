/**
 * Maps `EngineConfig`'s embed/rerank sub-objects to the client configs
 * `embed-client.ts`/`rerank-client.ts` dispatch on. This is the ONLY place
 * that mapping happens — every construction site (search, capture, and any
 * future caller) must go through these functions so operator overrides like
 * EMBED_TIMEOUT_MS / RERANK_TIMEOUT_MS reach every code path uniformly.
 */
import type { EngineConfig } from "../config.ts";
import type { EmbedClientConfig } from "./embed-client.ts";
import type { RerankClientConfig } from "./rerank-client.ts";

const VALID_EMBED_API_STYLES = new Set(["openai", "tei", "ollama"]);

// The engine's `EngineConfig.embed.apiStyle` is a plain, operator-set string
// (config.ts has no arktype gate on it); `EmbedClientConfig` requires the
// literal union `embed-client.ts` dispatches on. Validated here, once, at
// the trust boundary between config and the client — an invalid value is an
// operator misconfiguration and must fail loudly, not silently degrade.
// Built from the engine's own operator-configured embed endpoint — a trusted
// URL, the same as DATABASE_URL. Absent `embed` => no embedding account
// configured => `undefined`, the same degrade-soft precedent already used by
// `toRerankClientConfig` below — a caller must skip dense retrieval / the
// embed pass entirely rather than dispatch a client with no endpoint.
export function toEmbedClientConfig(
  embed: EngineConfig["embed"],
): EmbedClientConfig | undefined {
  if (!embed) return undefined;
  if (!VALID_EMBED_API_STYLES.has(embed.apiStyle)) {
    throw new Error(
      `Invalid EMBED_API_STYLE "${embed.apiStyle}" — must be one of: ${[...VALID_EMBED_API_STYLES].join(", ")}`,
    );
  }
  return {
    baseUrl: embed.baseUrl,
    modelId: embed.model,
    apiStyle: embed.apiStyle as EmbedClientConfig["apiStyle"],
    ...(embed.apiKey !== undefined ? { apiKey: embed.apiKey } : {}),
    ...(embed.timeoutMs !== undefined ? { timeoutMs: embed.timeoutMs } : {}),
  };
}

// `EngineConfig.rerank` carries no `apiStyle` field — the engine currently
// wires only a TEI-compatible cross-encoder endpoint (the locked default
// model, `bge-reranker-v2-m3`, is TEI-servable); rerank apiStyle is hardcoded
// `"tei"` below. Absent `baseUrl` => rerank is unconfigured => `undefined`,
// same degrade-soft precedent as the embed config being absent upstream.
// Built from the engine's own operator-configured rerank endpoint — a trusted
// URL, the same as DATABASE_URL.
export function toRerankClientConfig(
  rerank: EngineConfig["rerank"],
): RerankClientConfig | undefined {
  if (!rerank.baseUrl) return undefined;
  return {
    baseUrl: rerank.baseUrl,
    apiStyle: "tei",
    ...(rerank.model !== undefined ? { model: rerank.model } : {}),
    ...(rerank.apiKey !== undefined ? { apiKey: rerank.apiKey } : {}),
    ...(rerank.maxDocChars !== undefined
      ? { maxDocChars: rerank.maxDocChars }
      : {}),
    ...(rerank.timeoutMs !== undefined
      ? { timeoutMs: rerank.timeoutMs }
      : {}),
  };
}
