/**
 * Thin HTTP client for mounted hub memory routes.
 *
 * Tools never touch the in-process plane — they only call
 * `/api/tenants/:tenantId/memory/*` with credentials from install env.
 */

export type MemoryHttpConfig = {
  baseUrl: string;
  tenantId: string;
  authToken: string;
  fetch?: typeof globalThis.fetch;
};

export type MemoryAddBody = {
  title: string;
  text: string;
  access_tags?: string[];
  share?: {
    tenant?: boolean;
    principals?: string[];
    tags?: string[];
  };
};

export type MemorySearchBody = {
  query: string;
  limit?: number;
  kinds?: string[];
  entity_ids?: string[];
  sources?: string[];
  includeEvidence?: boolean;
};

export type MemoryHttpClient = {
  add(body: MemoryAddBody, signal?: AbortSignal): Promise<unknown>;
  search(body: MemorySearchBody, signal?: AbortSignal): Promise<unknown>;
  list(limit?: number, signal?: AbortSignal): Promise<unknown>;
};

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function createMemoryHttpClient(
  config: MemoryHttpConfig,
): MemoryHttpClient {
  const base = stripTrailingSlash(config.baseUrl);
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
      const detail = text.trim() || res.statusText || "request failed";
      throw new Error(`memory HTTP ${res.status}: ${detail}`);
    }

    return res.json();
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
  return { baseUrl, tenantId, authToken };
}
