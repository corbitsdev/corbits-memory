/**
 * Supermemory DocumentStore adapter (replaceable durable backend).
 *
 * Pure fetch HTTP — no vendor SDK. Port shapes are defined locally so this
 * package never imports the @corbits/memory runtime.
 *
 * Product path: createSupermemoryDocumentStore → mount as options.documentStore.
 * MemoryProvider factory is back-compat only.
 */

/** Minimal citation open shape (matches @corbits/memory SearchHitCitation). */
export type DocumentStoreCitation = {
  adapter: string;
  external_ref: string;
  open: {
    type: string;
    id: string;
    url?: string;
  };
};

export type DocumentStoreAddParams = {
  tenantId: string;
  principalId: string;
  title: string;
  text: string;
  /** Grant-tag resource strings (ignored for enforcement; principal-bucket only). */
  accessTags: string[];
  attributes?: Record<string, string | number | boolean | null>;
  externalRef?: string;
  adapter?: string;
  kind?: string;
};

export type DocumentStoreFindParams = {
  tenantId: string;
  principalId: string;
  query: string;
  limit?: number;
  includeEvidence?: boolean;
};

export type DocumentStoreFindItem = {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
  kind: string;
  citation: DocumentStoreCitation;
  adapter?: string;
  externalRef?: string;
  updatedAt?: string;
};

export type DocumentStoreFindResult = {
  items: DocumentStoreFindItem[];
  evidence?: "strong" | "weak" | "none";
  degraded?: string[];
};

export type DocumentStoreRecentParams = {
  tenantId: string;
  principalId: string;
  limit?: number;
};

export type DocumentStoreRecentEvent = {
  at: string;
  title: string;
  source: string;
  tenantId: string;
  principalId: string;
};

/**
 * Replaceable durable backend for the knowledge plane (add / find / recent).
 * Mount as `options.documentStore` — no local Postgres required.
 */
export type DocumentStore = {
  add(params: DocumentStoreAddParams): Promise<{ documentId: string }>;
  find(params: DocumentStoreFindParams): Promise<DocumentStoreFindResult>;
  recent(
    params: DocumentStoreRecentParams,
  ): Promise<DocumentStoreRecentEvent[]>;
  close(): Promise<void>;
};

/** @deprecated Prefer DocumentStore. Thin remember/recall only. */
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
const ADAPTER = "supermemory";

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

export type SupermemoryClientOpts = {
  apiKey: string;
  /** API root (no trailing slash). Default: https://api.supermemory.ai */
  baseUrl?: string;
  /** Injectable fetch for tests. Default: globalThis.fetch */
  fetch?: typeof fetch;
};

/** @deprecated Use SupermemoryClientOpts */
export type SupermemoryMemoryProviderOpts = SupermemoryClientOpts;

function requireIdentity(tenantId: string, principalId: string): void {
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error(
      "Supermemory DocumentStore requires non-empty tenantId and principalId",
    );
  }
  if (typeof principalId !== "string" || principalId.trim() === "") {
    throw new Error(
      "Supermemory DocumentStore requires non-empty tenantId and principalId",
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

function encodeContent(params: {
  title: string;
  text: string;
  documentId: string;
  externalRef?: string;
  accessTags: string[];
}): string {
  const header = `# ${params.title}`;
  const meta = [
    `documentId: ${params.documentId}`,
    params.externalRef ? `externalRef: ${params.externalRef}` : null,
    params.accessTags.length > 0
      ? `accessTags: ${params.accessTags.join(",")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `${header}\n\n${params.text}\n\n---\n${meta}`;
}

function parseTitleAndSnippet(text: string): { title: string; snippet: string } {
  const lines = text.split("\n");
  if (lines[0]?.startsWith("# ")) {
    const title = lines[0].slice(2).trim() || "untitled";
    const rest = lines
      .slice(1)
      .join("\n")
      .replace(/\n---\n[\s\S]*$/, "")
      .trim();
    return {
      title,
      snippet: rest.slice(0, 240) || title,
    };
  }
  return {
    title: text.slice(0, 80) || "untitled",
    snippet: text.slice(0, 240),
  };
}

/**
 * Create a DocumentStore backed by Supermemory (v3 documents + v4 search).
 *
 * Pure fetch — no vendor SDK. Mount as the plane's durable backend:
 *
 * ```ts
 * createMemory(undefined, grants, {
 *   documentStore: createSupermemoryDocumentStore({ apiKey }),
 * })
 * ```
 *
 * Find uses hybrid search (documents + chunks) so the store can answer
 * retrieval for add/find/ask — not memories-only personal facts.
 */
export function createSupermemoryDocumentStore(
  opts: SupermemoryClientOpts,
): DocumentStore {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const { apiKey } = opts;

  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error(
      "createSupermemoryDocumentStore requires a non-empty apiKey",
    );
  }

  return {
    async add(params) {
      requireIdentity(params.tenantId, params.principalId);
      const tag = containerTag(params.tenantId, params.principalId);
      const documentId = crypto.randomUUID();
      const content = encodeContent({
        title: params.title,
        text: params.text,
        documentId,
        ...(params.externalRef !== undefined
          ? { externalRef: params.externalRef }
          : {}),
        accessTags: params.accessTags ?? [],
      });
      const metadata: Record<string, string> = {
        documentId,
        title: params.title,
      };
      if (params.accessTags?.length) {
        metadata.accessTags = params.accessTags.join(",");
      }
      if (params.externalRef !== undefined) {
        metadata.externalRef = params.externalRef;
      }

      const res = await fetchImpl(`${baseUrl}/v3/documents`, {
        method: "POST",
        headers: jsonHeaders(apiKey),
        body: JSON.stringify({
          content,
          containerTag: tag,
          metadata,
        }),
      });
      if (!res.ok) {
        const snippet = await readErrorBody(res);
        throw new Error(
          `Supermemory add failed HTTP ${res.status}: ${snippet}`,
        );
      }
      return { documentId };
    },

    async find(params) {
      requireIdentity(params.tenantId, params.principalId);
      const tag = containerTag(params.tenantId, params.principalId);
      const body: Record<string, unknown> = {
        q: params.query,
        containerTag: tag,
        // Hybrid retrieval for store replacement (not memories-only facts).
        searchMode: "hybrid",
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
          `Supermemory find failed HTTP ${res.status}: ${snippet}`,
        );
      }

      const data = (await res.json()) as {
        results?: Array<{
          id?: string;
          memory?: string;
          chunk?: string;
          content?: string;
          similarity?: number;
          metadata?: Record<string, unknown>;
        }>;
      };

      const results = data.results ?? [];
      const items: DocumentStoreFindItem[] = [];
      for (const r of results) {
        const text = r.memory ?? r.chunk ?? r.content ?? "";
        if (text === "") continue;
        const meta = r.metadata ?? {};
        const documentId =
          (typeof meta.documentId === "string" && meta.documentId) ||
          (typeof r.id === "string" && r.id) ||
          crypto.randomUUID();
        const externalRef =
          (typeof meta.externalRef === "string" && meta.externalRef) ||
          documentId;
        const { title, snippet } = parseTitleAndSnippet(text);
        const score =
          typeof r.similarity === "number" && Number.isFinite(r.similarity)
            ? r.similarity
            : 0.5;
        items.push({
          documentId,
          title,
          snippet,
          score,
          kind: "note",
          adapter: ADAPTER,
          externalRef,
          citation: {
            adapter: ADAPTER,
            external_ref: externalRef,
            open: {
              type: "document",
              id: documentId,
              url: `supermemory://${documentId}`,
            },
          },
        });
      }

      if (params.includeEvidence) {
        return {
          items,
          evidence: items.length === 0 ? "none" : "weak",
        };
      }
      return { items };
    },

    async recent() {
      return [];
    },

    async close() {
      // Stateless HTTP client.
    },
  };
}

/**
 * @deprecated Prefer createSupermemoryDocumentStore as options.documentStore.
 * Thin remember/recall kept for back-compat; not the product path.
 */
export function createSupermemoryMemoryProvider(
  opts: SupermemoryClientOpts,
): MemoryProvider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const { apiKey } = opts;

  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error(
      "createSupermemoryMemoryProvider requires a non-empty apiKey",
    );
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
        // Legacy memories-only path for personal-fact recall.
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
