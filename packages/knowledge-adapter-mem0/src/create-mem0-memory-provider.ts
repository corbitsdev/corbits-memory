/**
 * @deprecated Prefer createMem0DocumentStore and mount as documentStore.
 * Thin remember/recall wrapper kept for back-compat only — not the product path.
 */
import { mapUser } from "./map-user.ts";
import type { Mem0ClientOptions, MemoryProvider } from "./types.ts";

const DEFAULT_BASE_URL = "https://api.mem0.ai";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "";
  }
}

/**
 * @deprecated Use createMem0DocumentStore({ apiKey }) as options.documentStore.
 */
export function createMem0MemoryProvider(
  opts: Mem0ClientOptions,
): MemoryProvider {
  if (typeof opts.apiKey !== "string" || opts.apiKey.trim() === "") {
    throw new Error(
      "createMem0MemoryProvider: apiKey is required and must be a non-empty string",
    );
  }

  const baseUrl = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const authHeader = `Token ${opts.apiKey}`;

  async function mem0Post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `${baseUrl}${path}`;
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new Error(
        `Mem0 API ${path} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
      );
    }

    if (res.status === 204) return undefined;
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  return {
    async remember(params) {
      const userId = mapUser(params.tenantId, params.principalId);
      const body: Record<string, unknown> = {
        messages: [{ role: "user", content: params.text }],
        user_id: userId,
        infer: false,
      };
      if (params.metadata !== undefined) {
        body.metadata = params.metadata;
      }
      await mem0Post("/v3/memories/add/", body);
    },

    async recall(params) {
      const userId = mapUser(params.tenantId, params.principalId);
      const topK = params.limit ?? 5;
      const raw = await mem0Post("/v3/memories/search/", {
        query: params.query,
        filters: { user_id: userId },
        top_k: topK,
      });
      return parseSearchResults(raw);
    },
  };
}

/** Normalize Mem0 search JSON into MemoryProvider recall hits. */
export function parseSearchResults(
  raw: unknown,
): Array<{ text: string; score?: number }> {
  if (raw == null) return [];

  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.results)) {
      items = obj.results;
    } else if (Array.isArray(obj.memories)) {
      items = obj.memories;
    }
  }

  const out: Array<{ text: string; score?: number }> = [];
  for (const item of items) {
    if (item == null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const text =
      typeof row.memory === "string"
        ? row.memory
        : typeof row.text === "string"
          ? row.text
          : null;
    if (text == null) continue;
    const score =
      typeof row.score === "number" && Number.isFinite(row.score)
        ? row.score
        : undefined;
    if (score === undefined) {
      out.push({ text });
    } else {
      out.push({ text, score });
    }
  }
  return out;
}
