/**
 * Supermemory MemoryProvider adapter.
 *
 * Pure fetch HTTP against the Supermemory REST API — no vendor SDK.
 * MemoryProvider is defined locally so this package never imports the
 * knowledge-engine runtime.
 */

/** Local port contract (mirrors knowledge-engine MemoryProvider). */
export type MemoryProvider = {
  remember(params: {
    tenantId: string;
    principalId: string;
    text: string;
    metadata?: Record<string, string>;
  }): Promise<void>;
  recall(params: {
    tenantId: string;
    principalId: string;
    query: string;
    limit?: number;
  }): Promise<Array<{ text: string; score?: number }>>;
};

const DEFAULT_BASE_URL = "https://api.supermemory.ai";

/**
 * Map tenant + principal to a Supermemory containerTag.
 * Length-prefixed so free-form ids cannot collide across delimiter injection:
 * `t{len}_{tenant}_u{len}_{principal}`
 */
export function containerTag(tenantId: string, principalId: string): string {
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error(
      "containerTag requires non-empty tenantId and principalId",
    );
  }
  if (typeof principalId !== "string" || principalId.trim() === "") {
    throw new Error(
      "containerTag requires non-empty tenantId and principalId",
    );
  }
  return `t${tenantId.length}_${tenantId}_u${principalId.length}_${principalId}`;
}

export type SupermemoryMemoryProviderOpts = {
  apiKey: string;
  /** API root (no trailing slash). Default: https://api.supermemory.ai */
  baseUrl?: string;
  /** Injectable fetch for tests. Default: globalThis.fetch */
  fetch?: typeof fetch;
};

function requireIdentity(tenantId: string, principalId: string): void {
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error(
      "remember/recall requires non-empty tenantId and principalId",
    );
  }
  if (typeof principalId !== "string" || principalId.trim() === "") {
    throw new Error(
      "remember/recall requires non-empty tenantId and principalId",
    );
  }
}

function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "";
  }
}

/**
 * Create a MemoryProvider backed by Supermemory (v3 documents + v4 search).
 *
 * recall always sends `searchMode: "memories"` so only extracted facts are
 * returned — never hybrid/documents defaults.
 */
export function createSupermemoryMemoryProvider(
  opts: SupermemoryMemoryProviderOpts,
): MemoryProvider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const { apiKey } = opts;

  if (!apiKey) {
    throw new Error("createSupermemoryMemoryProvider requires a non-empty apiKey");
  }

  return {
    async remember(params) {
      requireIdentity(params.tenantId, params.principalId);
      const tag = containerTag(params.tenantId, params.principalId);
      const body: Record<string, unknown> = {
        content: params.text,
        containerTag: tag,
      };
      if (params.metadata !== undefined) {
        body.metadata = params.metadata;
      }

      const res = await fetchImpl(`${baseUrl}/v3/documents`, {
        method: "POST",
        headers: jsonHeaders(apiKey),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const snippet = await readErrorBody(res);
        throw new Error(
          `Supermemory remember failed HTTP ${res.status}: ${snippet}`,
        );
      }
    },

    async recall(params) {
      requireIdentity(params.tenantId, params.principalId);
      const tag = containerTag(params.tenantId, params.principalId);
      const body: Record<string, unknown> = {
        q: params.query,
        containerTag: tag,
        // Always memories — never rely on API default.
        searchMode: "memories",
      };
      if (params.limit !== undefined) {
        body.limit = params.limit;
      }

      const res = await fetchImpl(`${baseUrl}/v4/search`, {
        method: "POST",
        headers: jsonHeaders(apiKey),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const snippet = await readErrorBody(res);
        throw new Error(
          `Supermemory recall failed HTTP ${res.status}: ${snippet}`,
        );
      }

      const data = (await res.json()) as {
        results?: Array<{
          memory?: string;
          chunk?: string;
          similarity?: number;
        }>;
      };

      const results = data.results ?? [];
      return results
        .map((r) => {
          const text = r.memory ?? r.chunk ?? "";
          if (text === "") return null;
          const item: { text: string; score?: number } = { text };
          if (typeof r.similarity === "number") {
            item.score = r.similarity;
          }
          return item;
        })
        .filter((x): x is { text: string; score?: number } => x !== null);
    },
  };
}
