/**
 * Port contracts for pluggable storage, live sources, and optional personal memory.
 *
 * DocumentStore is the durable backend for add/find/recent (default: local
 * pgvector). Hosts replace it with Mem0, Supermemory, or fakes — no dual store.
 * SourceProvider is tools-shaped live connectors (e.g. Linear), not a store.
 * MemoryProvider is an optional ask side-channel (includeMemory); not how you
 * swap backends.
 */
import type { VisibilitySpec } from "../core/schemas/document.ts";
import type {
  SearchEvidence,
  SearchHit,
  SearchHitCitation,
} from "../core/schemas/search.ts";
import type { DegradeFlag } from "../core/hybrid-search.ts";

/** Input the plane hands the store after content/file/share resolution. */
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
  citation: SearchHitCitation;
  /** When set, used by merge dedupe (`adapter:externalRef`). */
  adapter?: string;
  externalRef?: string;
  updatedAt?: string;
};

export type DocumentStoreFindResult = {
  items: DocumentStoreFindItem[];
  evidence?: SearchEvidence;
  degraded?: DegradeFlag[];
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
 * Durable document plane. Default implementation is the engine's pgvector
 * store. Hosts inject Mem0 / Supermemory / fakes via `options.documentStore`
 * to replace local Postgres entirely — this is the only product path for
 * swapping backends.
 */
export type DocumentStore = {
  add(params: DocumentStoreAddParams): Promise<{ documentId: string }>;
  find(params: DocumentStoreFindParams): Promise<DocumentStoreFindResult>;
  recent(
    params: DocumentStoreRecentParams,
  ): Promise<DocumentStoreRecentEvent[]>;
  close(): Promise<void>;
};

/**
 * One live hit from a SourceProvider.searchLive call.
 * Dedupe key for merge is `adapter:externalRef`.
 */
export type LiveSearchItem = {
  adapter: string;
  externalRef: string;
  title: string;
  snippet: string;
  score: number;
  kind: string;
  citation: SearchHitCitation;
  /** ISO timestamp for recency prior when present. */
  updatedAt?: string;
};

/**
 * Thin connector port. By default a provider only supplies capture inputs
 * (adapter id + mapping live outside this type). `searchLive` is optional —
 * providers that can answer live queries implement it.
 */
export type SourceProvider = {
  readonly id: string;
  searchLive?(params: {
    query: string;
    tenantId: string;
    principalId: string;
    limit?: number;
  }): Promise<LiveSearchItem[]>;
};

/**
 * Optional personal-memory side channel for ask(includeMemory). Not a
 * DocumentStore replacement — Mem0/Supermemory product adapters implement
 * DocumentStore, not this port.
 */
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

// Keep SearchHit import used if needed by consumers re-exporting citation shapes.
export type { SearchHit };
