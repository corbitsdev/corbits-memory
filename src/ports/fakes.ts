/**
 * In-package fakes for DocumentStore and SourceProvider.
 * Enough for hosts/tests to mount without Postgres or embed endpoints.
 */
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
  visibility: DocumentStoreAddParams["visibility"];
  blockPrincipalIds: string[];
  externalRef?: string;
  createdAt: string;
};

function visibleTo(doc: StoredDoc, principalId: string): boolean {
  if (doc.blockPrincipalIds.includes(principalId)) return false;
  const v = doc.visibility;
  if (v.mode === "tenant") return true;
  if (v.mode === "private" || v.mode === "principals") {
    return (v.principalIds ?? []).includes(principalId);
  }
  return false;
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
 * In-memory DocumentStore. ACL-aware substring match; no embeddings.
 */
export function createFakeDocumentStore(): DocumentStore {
  const docs: StoredDoc[] = [];
  let seq = 0;

  return {
    async add(params) {
      const documentId = `fake_doc_${++seq}`;
      const row: StoredDoc = {
        documentId,
        tenantId: params.tenantId,
        principalId: params.principalId,
        title: params.title,
        text: params.text,
        visibility: params.visibility,
        blockPrincipalIds: params.blockPrincipalIds ?? [],
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
      const items = docs
        .filter(
          (d) =>
            d.tenantId === params.tenantId &&
            visibleTo(d, params.principalId),
        )
        .map((d) => {
          const score = scoreMatch(params.query, d.title, d.text);
          return { d, score };
        })
        .filter((x) => x.score > 0)
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
      return docs
        .filter(
          (d) =>
            d.tenantId === params.tenantId &&
            visibleTo(d, params.principalId),
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map((d) => ({
          at: d.createdAt,
          title: d.title,
          source: "fake",
          tenantId: d.tenantId,
          principalId: d.principalId,
        }));
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
      const q = params.query.toLowerCase();
      const limit = params.limit ?? 8;
      return catalog
        .filter(
          (item) =>
            item.adapter === id &&
            (item.title.toLowerCase().includes(q) ||
              item.snippet.toLowerCase().includes(q)),
        )
        .slice(0, limit);
    },
  };
}

/** In-memory MemoryProvider for tests (M3 product wire still required). */
export function createFakeMemoryProvider(): MemoryProvider {
  const mem: Array<{
    tenantId: string;
    principalId: string;
    text: string;
  }> = [];
  return {
    async remember(params) {
      mem.push({
        tenantId: params.tenantId,
        principalId: params.principalId,
        text: params.text,
      });
    },
    async recall(params) {
      const q = params.query.toLowerCase();
      return mem
        .filter(
          (m) =>
            m.tenantId === params.tenantId &&
            m.principalId === params.principalId &&
            m.text.toLowerCase().includes(q),
        )
        .slice(0, params.limit ?? 5)
        .map((m) => ({ text: m.text, score: 1 }));
    },
  };
}
