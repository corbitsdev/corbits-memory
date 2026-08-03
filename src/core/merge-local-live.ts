/**
 * MergeLocalLiveV1 — combine local DocumentStore hits with live SourceProvider
 * hits into one ranked list.
 *
 * Spec (frozen for M3/M4):
 * - Per-channel score normalization before combining
 * - Dedupe key: `adapter:externalRef`
 * - On collision, prefer local
 * - Recency prior in ranking
 * - Live timeout + allSettled fan-out are applied by the caller; this module
 *   is pure merge over already-collected channel results
 */
import type { SearchHitCitation } from "./schemas/search.ts";

export const LIVE_TIMEOUT_MS = 800;

export type MergeDegradeFlag =
  | "live_timeout"
  | "live_error";

export type MergeChannelItem = {
  channel: "local" | "live";
  adapter: string;
  externalRef: string;
  documentId: string;
  title: string;
  snippet: string;
  /** Raw channel score (any scale). */
  score: number;
  kind: string;
  citation: SearchHitCitation;
  /** ISO timestamp for recency prior when present. */
  updatedAt?: string;
};

export type MergedFindItem = {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
  kind: string;
  citation: SearchHitCitation;
  adapter?: string;
  externalRef?: string;
  /** Which channel won after merge (local preferred on collision). */
  channel: "local" | "live";
};

export type MergeLocalLiveInput = {
  local: readonly MergeChannelItem[];
  live: readonly MergeChannelItem[];
  limit: number;
  /**
   * Restrict which channels contribute. `"local"` keeps the DocumentStore
   * channel; other strings match SourceProvider ids (live adapter).
   * Omit to include everything.
   */
  sources?: readonly string[];
  /** Injected clock for recency (tests). Defaults to Date.now(). */
  nowMs?: number;
};

export type MergeLocalLiveResult = {
  items: MergedFindItem[];
};

function dedupeKey(item: MergeChannelItem): string {
  return `${item.adapter}:${item.externalRef}`;
}

/** Max-normalize scores within a channel to [0, 1]. */
function normalizeChannel(
  items: readonly MergeChannelItem[],
): Array<MergeChannelItem & { normScore: number }> {
  if (items.length === 0) return [];
  let max = 0;
  for (const it of items) {
    if (it.score > max) max = it.score;
  }
  return items.map((it) => ({
    ...it,
    normScore: max > 0 ? it.score / max : 0,
  }));
}

/**
 * Recency prior in [0, 1]. Half-life ~30 days; missing timestamp → neutral 0.5.
 */
export function recencyPrior(
  updatedAt: string | undefined,
  nowMs: number,
): number {
  if (!updatedAt) return 0.5;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 0.5;
  const ageMs = Math.max(0, nowMs - t);
  const halfLife = 30 * 24 * 3600 * 1000;
  return Math.exp((-Math.LN2 * ageMs) / halfLife);
}

function combinedScore(
  normScore: number,
  updatedAt: string | undefined,
  nowMs: number,
): number {
  const recency = recencyPrior(updatedAt, nowMs);
  // Mostly relevance; recency breaks ties and lightly boosts fresher docs.
  return normScore * 0.85 + recency * 0.15;
}

function passesSourceFilter(
  item: MergeChannelItem,
  sources: readonly string[] | undefined,
): boolean {
  if (!sources || sources.length === 0) return true;
  if (item.channel === "local") return sources.includes("local");
  return sources.includes(item.adapter);
}

/**
 * Pure merge of local + live channel results.
 */
export function mergeLocalLiveV1(
  input: MergeLocalLiveInput,
): MergeLocalLiveResult {
  const nowMs = input.nowMs ?? Date.now();
  const limit = Math.max(0, input.limit);

  const localFiltered = input.local.filter((it) =>
    passesSourceFilter(it, input.sources),
  );
  const liveFiltered = input.live.filter((it) =>
    passesSourceFilter(it, input.sources),
  );

  const localNorm = normalizeChannel(localFiltered);
  const liveNorm = normalizeChannel(liveFiltered);

  // Prefer local on collision: seed map with live, then overwrite with local.
  const byKey = new Map<
    string,
    MergeChannelItem & { normScore: number; combined: number }
  >();

  for (const it of liveNorm) {
    const combined = combinedScore(it.normScore, it.updatedAt, nowMs);
    byKey.set(dedupeKey(it), { ...it, combined });
  }
  for (const it of localNorm) {
    const key = dedupeKey(it);
    const combined = combinedScore(it.normScore, it.updatedAt, nowMs);
    // Prefer local even if live score was higher.
    byKey.set(key, { ...it, combined });
  }

  const ranked = [...byKey.values()].sort((a, b) => {
    if (b.combined !== a.combined) return b.combined - a.combined;
    // Stable-ish tie-break: local before live, then title.
    if (a.channel !== b.channel) return a.channel === "local" ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  const items: MergedFindItem[] = ranked.slice(0, limit).map((it) => ({
    documentId: it.documentId,
    title: it.title,
    snippet: it.snippet,
    score: it.combined,
    kind: it.kind,
    citation: it.citation,
    adapter: it.adapter,
    externalRef: it.externalRef,
    channel: it.channel,
  }));

  return { items };
}

/**
 * Race a promise against a timeout. Rejects with a tagged error on timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "live",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), {
        code: "live_timeout" as const,
      }));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
