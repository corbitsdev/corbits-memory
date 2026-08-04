/**
 * Port shapes — defined locally so this adapter never imports runtime from
 * @corbits/knowledge-engine. DocumentStore is the product plug (replaceable
 * durable backend). MemoryProvider is a thin legacy shape kept for back-compat.
 */

/** Minimal citation open shape (matches knowledge-engine SearchHitCitation). */
export type DocumentStoreCitation = {
  adapter: string;
  external_ref: string;
  open: {
    type: string;
    id: string;
    url?: string;
  };
};

export type VisibilitySpec =
  | { mode: "tenant" }
  | { mode: "private"; principalIds: string[] }
  | { mode: "principals"; principalIds: string[] };

export type DocumentStoreAddParams = {
  tenantId: string;
  principalId: string;
  title: string;
  text: string;
  visibility: VisibilitySpec;
  blockPrincipalIds?: string[];
  attributes?: Record<string, string | number | boolean | null>;
  externalRef?: string;
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

export type Mem0ClientOptions = {
  /** Mem0 platform API key (sent as `Authorization: Token …`). */
  apiKey: string;
  /** API origin; default `https://api.mem0.ai`. */
  baseUrl?: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetch?: typeof fetch;
};

/** @deprecated Use Mem0ClientOptions */
export type Mem0MemoryProviderOptions = Mem0ClientOptions;
