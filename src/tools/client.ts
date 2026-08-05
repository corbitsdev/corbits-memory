/**
 * Thin HTTP client for mounted hub memory routes.
 *
 * Tools never touch the in-process plane — they only call
 * `/api/tenants/:tenantId/memory/*` with credentials from install env.
 *
 * Pass `signal` on each call (or via the tool runner) so a hung hub can be
 * cancelled; this client does not invent a default timeout.
 */
import type { AddRequest, SearchRequest } from "../http-bodies.ts";

export type MemoryHttpConfig = {
  baseUrl: string;
  tenantId: string;
  authToken: string;
  fetch?: typeof globalThis.fetch;
};

/** Wire body for POST /memory/add — same shape as shared AddRequest. */
export type MemoryAddBody = AddRequest;

/** Wire body for POST /memory/search — same shape as shared SearchRequest. */
export type MemorySearchBody = SearchRequest;

export type MemoryHttpClient = {
  add(body: MemoryAddBody, signal?: AbortSignal): Promise<unknown>;
  search(body: MemorySearchBody, signal?: AbortSignal): Promise<unknown>;
  list(limit?: number, signal?: AbortSignal): Promise<unknown>;
};

/** Cap hub error text embedded in tool errors (avoid huge/secret-ish dumps). */
const MAX_ERROR_DETAIL_CHARS = 512;

function stripTrailingSlashes(url: string): string {
  let out = url;
  while (out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

function clipErrorDetail(text: string): string {
  const t = text.trim();
  if (t.length <= MAX_ERROR_DETAIL_CHARS) return t;
  return `${t.slice(0, MAX_ERROR_DETAIL_CHARS)}…`;
}

export function createMemoryHttpClient(
  config: MemoryHttpConfig,
): MemoryHttpClient {
  const base = stripTrailingSlashes(config.baseUrl);
  const root = `${base}/api/tenants/${encodeURIComponent(config.tenantId)}/memory`;
  const doFetch = config.fetch ?? globalThis.fetch.bind(globalThis);

  async function request(
    path: string,
    init: {
      method: string;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.authToken}`,
      Accept: "application/json",
    };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const fetchInit: RequestInit = {
      method: init.method,
      headers,
    };
    if (init.body !== undefined) {
      fetchInit.body = init.body;
    }
    if (init.signal !== undefined) {
      fetchInit.signal = init.signal;
    }

    const res = await doFetch(`${root}${path}`, fetchInit);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail =
        clipErrorDetail(text) || res.statusText || "request failed";
      throw new Error(`memory HTTP ${res.status}: ${detail}`);
    }

    const text = await res.text().catch(() => "");
    if (!text.trim()) {
      return {};
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new Error(
        `memory HTTP ${res.status}: invalid JSON response`,
        { cause },
      );
    }
  }

  return {
    add(body, signal) {
      return request("/add", {
        method: "POST",
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      });
    },
    search(body, signal) {
      return request("/search", {
        method: "POST",
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      });
    },
    list(limit, signal) {
      const qs =
        limit !== undefined
          ? `?limit=${encodeURIComponent(String(limit))}`
          : "";
      return request(`/list${qs}`, {
        method: "GET",
        ...(signal !== undefined ? { signal } : {}),
      });
    },
  };
}

/** Env keys declared by every memory tool factory via `requires`. */
export const MEMORY_TOOL_ENV_KEYS = [
  "memoryBaseUrl",
  "memoryTenantId",
  "memoryAuthToken",
] as const;

export type MemoryToolEnvKeys = (typeof MEMORY_TOOL_ENV_KEYS)[number];

export type MemoryToolEnv = {
  memoryBaseUrl: string;
  memoryTenantId: string;
  memoryAuthToken: string;
  /**
   * Optional host/test inject. Not part of `requires` — agents never set this.
   */
  memoryFetch?: typeof globalThis.fetch;
};

export function readMemoryToolEnv(env: MemoryToolEnv): MemoryHttpConfig {
  const baseUrl = env.memoryBaseUrl;
  const tenantId = env.memoryTenantId;
  const authToken = env.memoryAuthToken;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error("memoryBaseUrl must be a non-empty string");
  }
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("memoryTenantId must be a non-empty string");
  }
  if (typeof authToken !== "string" || authToken.length === 0) {
    throw new Error("memoryAuthToken must be a non-empty string");
  }
  return {
    baseUrl,
    tenantId,
    authToken,
    ...(env.memoryFetch !== undefined ? { fetch: env.memoryFetch } : {}),
  };
}
