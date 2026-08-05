/**
 * In-package fakes for DocumentStore and SourceProvider.
 * Enough for hosts/tests to mount without Postgres or embed endpoints.
 *
 * Document access: creator always sees own docs; otherwise any accessTag that
 * authorize(grants, …, tag, "find") allows when grants are provided. Without
 * grants, only creator access (safe default for unit tests).
 */
import { canAccessDocument } from "../acl.ts";
import type {
  DocumentStore,
  DocumentStoreAddParams,
  DocumentStoreFindParams,
  DocumentStoreFindResult,
  DocumentStoreRecentEvent,
  DocumentStoreRecentParams,
  LiveSearchItem,
  MemoryProvider,
  SourceProvider,
} from "./types.ts";

type StoredDoc = {
  documentId: string;
  tenantId: string;
  principalId: string;
  title: string;
  text: string;
  accessTags: string[];
  externalRef?: string;
  createdAt: string;
};

async function visibleTo(
  doc: StoredDoc,
  params: {
    principalId: string;
    tenantId: string;
    grants?: DocumentStoreFindParams["grants"];
    conditionRegistry?: DocumentStoreFindParams["conditionRegistry"];
  },
): Promise<boolean> {
  if (!params.grants) {
    return doc.principalId === params.principalId;
  }
  return canAccessDocument({
    grants: params.grants,
    tenantId: params.tenantId,
    principalId: params.principalId,
    createdByPrincipalId: doc.principalId,
    accessTags: doc.accessTags,
    ...(params.conditionRegistry !== undefined
      ? { conditionRegistry: params.conditionRegistry }
      : {}),
  });
}

function scoreMatch(query: string, title: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const hay = `${title}\n${text}`.toLowerCase();
  if (!hay.includes(q)) return 0;
  if (title.toLowerCase().includes(q)) return 1;
  return 0.5;
}

/**
 * In-memory DocumentStore. Grant-tag ACL when grants passed; creator-only otherwise.
 */
export function createFakeDocumentStore(): DocumentStore {
  const docs: StoredDoc[] = [];
  let seq = 0;

  return {
    async add(params: DocumentStoreAddParams) {
      const documentId = `fake_doc_${++seq}`;
      const row: StoredDoc = {
        documentId,
        tenantId: params.tenantId,
        principalId: params.principalId,
        title: params.title,
        text: params.text,
        accessTags: [...params.accessTags],
        createdAt: new Date().toISOString(),
      };
      if (params.externalRef !== undefined) {
        row.externalRef = params.externalRef;
      }
      docs.push(row);
      return { documentId };
    },

    async find(
      params: DocumentStoreFindParams,
    ): Promise<DocumentStoreFindResult> {
      const limit = params.limit ?? 8;
      const scored: { d: StoredDoc; score: number }[] = [];
      for (const d of docs) {
        if (d.tenantId !== params.tenantId) continue;
        const ok = await visibleTo(d, params);
        if (!ok) continue;
        const score = scoreMatch(params.query, d.title, d.text);
        if (score > 0) scored.push({ d, score });
      }
      const items = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ d, score }) => ({
          documentId: d.documentId,
          title: d.title,
          snippet: d.text.slice(0, 240),
          score,
          kind: "note",
          citation: {
            adapter: "fake",
            external_ref: d.externalRef ?? d.documentId,
            open: {
              type: "document",
              id: d.documentId,
              url: `fake://${d.documentId}`,
            },
          },
        }));

      if (params.includeEvidence) {
        return {
          items,
          evidence: items.length === 0 ? "none" : "weak",
        };
      }
      return { items };
    },

    async recent(
      params: DocumentStoreRecentParams,
    ): Promise<DocumentStoreRecentEvent[]> {
      const limit = params.limit ?? 50;
      const out: DocumentStoreRecentEvent[] = [];
      const sorted = [...docs]
        .filter((d) => d.tenantId === params.tenantId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      for (const d of sorted) {
        if (out.length >= limit) break;
        const ok = await visibleTo(d, params);
        if (!ok) continue;
        out.push({
          at: d.createdAt,
          title: d.title,
          source: "fake",
          tenantId: d.tenantId,
          principalId: d.principalId,
        });
      }
      return out;
    },

    async close() {
      docs.length = 0;
    },
  };
}

/**
 * SourceProvider with an optional fixed live catalog for tests.
 */
export function createFakeSourceProvider(
  id: string,
  catalog: LiveSearchItem[] = [],
): SourceProvider {
  return {
    id,
    async searchLive(params) {
      const q = params.query.toLowerCase().trim();
      const limit = params.limit ?? 8;
      return catalog
        .filter(
          (item) =>
            !q ||
            item.title.toLowerCase().includes(q) ||
            item.snippet.toLowerCase().includes(q),
        )
        .slice(0, limit);
    },
  };
}

/**
 * In-memory MemoryProvider for tests.
 */
export function createFakeMemoryProvider(): MemoryProvider {
  const byKey = new Map<string, string[]>();
  const key = (tenantId: string, principalId: string) =>
    `${tenantId}::${principalId}`;
  return {
    async remember(params) {
      const k = key(params.tenantId, params.principalId);
      const list = byKey.get(k) ?? [];
      list.push(params.text);
      byKey.set(k, list);
    },
    async recall(params) {
      const list = byKey.get(key(params.tenantId, params.principalId)) ?? [];
      const q = params.query.toLowerCase();
      const limit = params.limit ?? 5;
      return list
        .filter((t) => !q || t.toLowerCase().includes(q))
        .slice(0, limit)
        .map((text) => ({ text, score: 1 }));
    },
  };
}
