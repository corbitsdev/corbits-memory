/**
 * Port contracts for pluggable storage and live sources.
 *
 * DocumentStore is the durable backend for add/search/list (default: local
 * pgvector). Hosts replace it with any DocumentStore implementation or fakes —
 * no dual store. SourceProvider is tools-shaped live connectors (e.g. Linear),
 * not a store.
 *
 * Document access uses Interchange grant tags (accessTags), not a mini-ACL.
 * See docs/AUTHZ-DOCUMENT-ACCESS.md.
 *
 * Inference (extract-on-add, synthesize answers) is host-owned and ephemeral —
 * call your own model, then `add` / `search`. Core does not mount an agent or
 * bake LLM into the write path.
 */
import type { GrantStore, ConditionRegistry } from "@intx/authz";
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
  /** Resource tags in grant-pattern space (security boundary). */
  accessTags: string[];
  attributes?: Record<string, string | number | boolean | null>;
  externalRef?: string;
  /** Capture adapter id (default engine store uses `"http"`). */
  adapter?: string;
  /** Document kind (default engine store uses `"note"`). */
  kind?: string;
};

export type DocumentStoreSearchParams = {
  tenantId: string;
  principalId: string;
  query: string;
  limit?: number;
  includeEvidence?: boolean;
  /** Narrow local retrieval by document kind (unset/`[]` = no filter). */
  kinds?: string[];
  /** Narrow local retrieval by linked entity ids (unset/`[]` = no filter). */
  entityIds?: string[];
  /** Include deprecated versions (CL-5871). */
  includeDeprecated?: boolean;
  /**
   * Host grant store for grant-tag document access (default engine + fakes).
   * Vendor stores may ignore (principal-bucket only).
   */
  grants?: GrantStore;
  conditionRegistry?: ConditionRegistry;
};

export type DocumentStoreSearchItem = {
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
  /**
   * Optional attribution block (CL-5870). Engine store always fills this;
   * vendor stores may omit.
   */
  attribution?: {
    versionId: string;
    provenance?: string;
    sourceClass?: string;
    temporalClass?: string;
    createdByKind?: string;
    generatorAgentId?: string | null;
    occurredAt?: string;
    validUntil?: string | null;
    evidence?: "strong" | "weak" | "none";
    supports?: number;
    contradicts?: number;
    derivedFrom?: string[];
  };
};

export type DocumentStoreSearchResult = {
  items: DocumentStoreSearchItem[];
  evidence?: SearchEvidence;
  degraded?: DegradeFlag[];
};

export type DocumentStoreListParams = {
  tenantId: string;
  principalId: string;
  limit?: number;
  grants?: GrantStore;
  conditionRegistry?: ConditionRegistry;
};

export type DocumentStoreListEvent = {
  at: string;
  title: string;
  source: string;
  tenantId: string;
  principalId: string;
};

export type DocumentStoreFeedParams = {
  tenantId: string;
  principalId: string;
  after?: number;
  limit?: number;
  excludeGenerator?: string;
  grants?: GrantStore;
  conditionRegistry?: ConditionRegistry;
};

export type DocumentStoreFeedEntry = {
  feedSeq: number;
  versionId: string;
  documentId: string;
  kind: string;
  title: string;
  status: string;
  createdByKind: string;
  generatorAgentId: string | null;
  provenance: string;
  occurredAt: string;
  createdAt: string;
};

export type DocumentStoreFeedResult = {
  entries: DocumentStoreFeedEntry[];
  nextCursor: number | null;
};

/**
 * Durable document plane. Default implementation is the engine's pgvector
 * store. Hosts inject a DocumentStore (or fakes) via `options.documentStore`
 * to replace local Postgres entirely — this is the only product path for
 * swapping backends.
 */
export type DocumentStoreAddResult = {
  documentId: string;
  /** Active version written (or existing active on noop). */
  versionId: string;
};

export type DocumentStore = {
  add(params: DocumentStoreAddParams): Promise<DocumentStoreAddResult>;
  search(params: DocumentStoreSearchParams): Promise<DocumentStoreSearchResult>;
  list(params: DocumentStoreListParams): Promise<DocumentStoreListEvent[]>;
  /**
   * Cursor pull of new live versions (CL-5868). Engine-only; vendor stores
   * may omit (plane returns 501).
   */
  feed?(params: DocumentStoreFeedParams): Promise<DocumentStoreFeedResult>;
  close(): Promise<void>;
  /**
   * Append access tags after insert (used by share materialization to stamp
   * `memory.doc:<id>` once the document id is known). Optional — stores that
   * omit it leave peer share grants without a matching tag (fail-closed).
   * Tenant is required so a forged documentId cannot retag another tenant.
   */
  appendAccessTags?(
    tenantId: string,
    documentId: string,
    tags: readonly string[],
  ): Promise<void>;
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

export type { SearchHit };
