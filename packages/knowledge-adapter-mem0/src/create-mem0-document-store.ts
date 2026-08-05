import { mapUser } from "./map-user.ts";
import type {
  DocumentStore,
  DocumentStoreFindItem,
  Mem0ClientOptions,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.mem0.ai";
const ADAPTER = "mem0";

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

function requireIdentity(tenantId: string, principalId: string): void {
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error("Mem0 DocumentStore requires non-empty tenantId");
  }
  if (typeof principalId !== "string" || principalId.trim() === "") {
    throw new Error("Mem0 DocumentStore requires non-empty principalId");
  }
}

function encodeDocumentBody(params: {
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

/** Normalize Mem0 search JSON into DocumentStore find items. */
export function parseFindResults(raw: unknown): DocumentStoreFindItem[] {
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

  const out: DocumentStoreFindItem[] = [];
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

    const idFromRow =
      typeof row.id === "string"
        ? row.id
        : typeof row.memory_id === "string"
          ? row.memory_id
          : undefined;
    const meta =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const documentId =
      (typeof meta.documentId === "string" && meta.documentId) ||
      idFromRow ||
      crypto.randomUUID();
    const externalRef =
      (typeof meta.externalRef === "string" && meta.externalRef) || documentId;
    const { title, snippet } = parseTitleAndSnippet(text);
    const score =
      typeof row.score === "number" && Number.isFinite(row.score)
        ? row.score
        : 0.5;

    out.push({
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
          url: `mem0://${documentId}`,
        },
      },
    });
  }
  return out;
}

/**
 * Create a DocumentStore backed by the Mem0 Platform HTTP API (v3).
 *
 * Pure fetch — no mem0 SDK. Mount as the plane's durable backend:
 *
 * ```ts
 * createKnowledgePlane(undefined, grants, {
 *   documentStore: createMem0DocumentStore({ apiKey }),
 * })
 * ```
 *
 * No local Postgres required. Tenancy is enforced via length-prefixed `user_id`
 * (`mapUser`); never pass bare principalId.
 */
export function createMem0DocumentStore(
  opts: Mem0ClientOptions,
): DocumentStore {
  if (typeof opts.apiKey !== "string" || opts.apiKey.trim() === "") {
    throw new Error(
      "createMem0DocumentStore: apiKey is required and must be a non-empty string",
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
    async add(params) {
      requireIdentity(params.tenantId, params.principalId);
      const userId = mapUser(params.tenantId, params.principalId);
      const documentId = crypto.randomUUID();
      const content = encodeDocumentBody({
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

      // Platform v3 add path (same as legacy MemoryProvider).
      await mem0Post("/v3/memories/add/", {
        messages: [{ role: "user", content }],
        user_id: userId,
        infer: false,
        metadata,
      });

      return { documentId };
    },

    async find(params) {
      requireIdentity(params.tenantId, params.principalId);
      const userId = mapUser(params.tenantId, params.principalId);
      const topK = params.limit ?? 8;
      const raw = await mem0Post("/v3/memories/search/", {
        query: params.query,
        filters: { user_id: userId },
        top_k: topK,
      });
      const items = parseFindResults(raw);
      if (params.includeEvidence) {
        return {
          items,
          evidence: items.length === 0 ? "none" : "weak",
        };
      }
      return { items };
    },

    async recent() {
      // Query-oriented API; no stable recent timeline in this thin adapter.
      return [];
    },

    async close() {
      // Stateless HTTP client.
    },
  };
}
