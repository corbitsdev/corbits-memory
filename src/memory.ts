import { authorize } from "@intx/authz";

import {
  canAccessDocument,
  resolveAccessTags,
  ownerTag,
  type ShareSugar,
} from "./grant-tags.ts";

import type { EngineConfig } from "./config.ts";
import { formatCaughtError, log } from "./log.ts";
import { createDb, type Db, type RawSql } from "./db/client.ts";
import { createFtsVerification, parseFtsLanguage } from "./core/fts-language.ts";
import { createRawSqlClient } from "./core/embed-sql.ts";
import type { SearchHit } from "./core/schemas/search.ts";
import { validateRerankConfig } from "./core/rerank-client.ts";
import { captureDocument, type CaptureDegradedReason } from "./services/capture.ts";
import {
  hybridSearch,
  MemorySearchInputError,
  toRerankClientConfig,
  type HybridSearchResult,
  DEFAULT_HYBRID_TOP_K,
} from "./services/search.ts";
import {
  listTimelineEvents,
  type TimelineEvent,
} from "./services/timeline.ts";
import {
  fetchFeed,
  feedPageAfterAccessFilter,
  type FeedEntry,
} from "./services/feed.ts";

import {
  createTransformConfig,
  demoteGeneration,
  listTransformConfigs,
  promoteGeneration,
  runTransform,
  type TransformConfigRow,
  type TransformRunRow,
} from "./services/transform.ts";
import {
  deprecateVersion,
  hardDeleteDocument,
  setRetentionClass,
  sweepEphemeral,
  tombstoneDocument,
} from "./services/retention.ts";
import {
  isOwner,
  resolveDocumentOwner,
  resolveVersionOwner,
} from "./services/retention-ownership.ts";
import {
  documentTag,
  materializeShareGrants,
  MEMORY_SHARE_CONDITION_REGISTRY,
} from "./services/share-grants.ts";

import {
  isWritableGrantStore,
} from "./ports/writable-grant-store.ts";
import type { TransformConfigParams, TransformScope } from "./core/schemas/transform.ts";
import {
  LIVE_TIMEOUT_MS,
  mergeLocalLiveV1,
  withTimeout,
  type MergeChannelItem,
  type MergeDegradeFlag,
} from "./core/merge-local-live.ts";
import type { DegradeFlag } from "./core/hybrid-search.ts";
import type { MemoryConfig } from "./mount-config.ts";
import type { GrantConfig } from "./routes/deps.ts";
import type {
  DocumentStore,
  DocumentStoreCapabilities,
  DocumentStoreSearchParams,
  SourceProvider,
} from "./ports/types.ts";
import {
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  SEARCH_LIMIT_MAX,
  SEARCH_LIMIT_MIN,
} from "./limits.ts";

// (drizzle select was used briefly for grant-tag load; raw sql keeps unit-test
// mocks simple and matches the rest of the engine store.)

// Re-export so hosts typing plane results don't reach into services/.
export type { HybridSearchResult } from "./services/search.ts";
export type { SearchHit } from "./core/schemas/search.ts";
export type {
  DocumentStore,
  DocumentStoreAddParams,
  DocumentStoreCapabilities,
  LiveSearchItem,
  SourceProvider,
} from "./ports/types.ts";
// Alias so hosts read `MemoryCapabilities` (the name on the `Memory` handle
// they actually hold) rather than reaching for the port-level type name.
export type MemoryCapabilities = DocumentStoreCapabilities;
export {
  SEARCH_LIMIT_MIN,
  SEARCH_LIMIT_MAX,
  LIST_LIMIT_MIN,
  LIST_LIMIT_MAX,
} from "./limits.ts";

export {
  resolveAccessTags,
  ownerTag,
  tenantTag,
  canAccessDocument,
  type ShareSugar,
} from "./grant-tags.ts";

/**
 * Optional host-supplied extractor for `add({ file })`. The engine never
 * ships a PDF/OCR/vendor SDK — the host plugs one in when file ingest is needed.
 */
export type TextExtractor = {
  extract(file: {
    bytes: Uint8Array;
    mimeType?: string;
    filename?: string;
  }): Promise<{ text: string; title?: string }>;
};

export type MemoryIdentity = {
  principalId: string;
  tenantId: string;
};

export type MemorySearchParams = MemoryIdentity & {
  query: string;
  /** Max items to return (1–50). Default 8. */
  limit?: number;
  /** When true, include evidence (and degraded if any). Default: omit. */
  includeEvidence?: boolean;
  /**
   * Narrows every retrieval channel to documents whose `kind` is one of
   * these — see `hybridSearch` in services/search.ts. Applied before fusion,
   * so a fused hit is always guaranteed to match. Unset or an empty array
   * both mean "no filter" (equivalent, not "match nothing").
   */
  kinds?: string[];
  /**
   * Same scoping as `kinds`, restricted to documents linked to one of these
   * entity ids. Unset or an empty array both mean "no filter".
   */
  entityIds?: string[];
  /**
   * Restrict channels: `"local"` and/or SourceProvider ids.
   * Omit to include all mounted sources plus local.
   */
  sources?: string[];
  /** Include deprecated versions in local retrieval (CL-5871). Default false. */
  includeDeprecated?: boolean;
};

export type MemoryShare = ShareSugar;

export type MemoryAddParams = MemoryIdentity & {
  /** Exactly one of `content` or `file` is required. */
  content?: { title: string; text: string };
  file?: {
    bytes: Uint8Array;
    mimeType?: string;
    filename?: string;
    title?: string;
  };
  kind?: string;
  adapter?: string;
  externalRef?: string;
  /**
   * Explicit resource tags in grant-pattern space. Always merged with the
   * owner tag for the caller.
   */
  accessTags?: string[];
  /**
   * Share sugar — mints tags, and when the host grant store is writable,
   * materializes peer grants on `memory.doc:<id>` (CL-5873).
   */
  share?: ShareSugar;
  attributes?: Record<string, string | number | boolean | null>;
  /**
   * Claim / distiller identity (optional). When `generatorAgentId` is set the
   * version is written as agent-authored so the capture feed can exclude it
   * via `excludeGenerator` (loop-safety).
   */
  generatorAgentId?: string;
  provenance?: "stated" | "inferred" | "unknown";
  lineageClass?: "native" | "imported" | "derived";
  temporalClass?: "event" | "deadline" | "state" | "lesson";
  /** Source version ids → `derived_from` edges on the new version. */
  derivedFrom?: string[];
  validFrom?: string;
  validUntil?: string;
};

export type MemoryAddResult = {
  documentId: string;
  versionId: string;
  /**
   * When `share.principals` was non-empty: true if peer grants were written
   * to a WritableGrantStore; false if materialization was skipped (no writable
   * store or soft failure). Omitted when no peer share was requested.
   */
  grantsMaterialized?: boolean;
  /**
   * Mirrors `search`'s `degraded` (a reason array, never a bare boolean) so
   * a host can write one "is this response degraded" check across both
   * verbs. Omitted when the document captured cleanly. See
   * `CaptureDegradedReason` (services/capture.ts).
   */
  degraded?: CaptureDegradedReason[];
};

export type SearchAttribution = {
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

export type SearchItem = {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
  kind: string;
  citation: SearchHit["citation"];
  /** ISO timestamp for merge recency when the store provides it. */
  updatedAt?: string;
  /** Additive provenance / temporal / corroboration for render-time attribution. */
  attribution?: SearchAttribution;
};

export type SearchResult = {
  items: SearchItem[];
  /** Only present when includeEvidence: true */
  evidence?: "strong" | "weak" | "none";
  degraded?: HybridSearchResult["degraded"];
};

export type MemoryListParams = MemoryIdentity & {
  limit?: number;
};

export type MemoryFeedParams = MemoryIdentity & {
  /** Exclusive cursor (last seen feedSeq). Default 0. */
  after?: number;
  limit?: number;
  excludeGenerator?: string;
};

export type MemoryFeedEntry = {
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
  /** Grant-pattern tags for claim writes (≤ source access). */
  accessTags: string[];
};

export type MemoryFeedResult = {
  entries: MemoryFeedEntry[];
  nextCursor: number | null;
};

export class MemoryError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export type Memory = {
  search(params: MemorySearchParams): Promise<SearchResult>;
  add(params: MemoryAddParams): Promise<MemoryAddResult>;
  list(params: MemoryListParams): Promise<TimelineEvent[]>;
  /**
   * Static capability facts, known at construction — check
   * `embeddingsConfigured` to learn recall is lexical-only WITHOUT issuing
   * a search first (CL-6287). Always present; a custom DocumentStore that
   * doesn't report its own capabilities defaults to
   * `embeddingsConfigured: true` (see DocumentStoreCapabilities).
   */
  readonly capabilities: MemoryCapabilities;
  /**
   * Cursor pull of new live versions (engine store only). Grant-checked like
   * search. See docs/FEED.md.
   */
  feed?(params: MemoryFeedParams): Promise<MemoryFeedResult>;
  close(): Promise<void>;
  /**
   * Transform / replay surface (engine DocumentStore only). Present when the
   * plane was built with engine config; absent on custom/fake stores.
   * Calling through a stub that omits these is a TypeScript error; runtime
   * throws MemoryError(501) only if a partial implementation is forced.
   */
  createTransformConfig?(input: {
    tenantId: string;
    name: string;
    params: TransformConfigParams;
  }): Promise<TransformConfigRow>;
  listTransformConfigs?(tenantId: string): Promise<TransformConfigRow[]>;
  runTransform?(input: {
    configId: string;
    scope?: TransformScope;
  }): Promise<TransformRunRow>;
  promoteGeneration?(input: {
    tenantId: string;
    generation: string;
  }): Promise<TransformRunRow>;
  demoteGeneration?(input: {
    tenantId: string;
    generation: string;
  }): Promise<TransformRunRow>;
  /**
   * Retention write paths (engine store only). See docs/RETENTION.md
   * (CL-5871, ownership CL-6288). `tombstoneDocument`, `hardDeleteDocument`,
   * and `setRetentionClass` take the caller's `principalId` and are refused
   * (`MemoryError` 403) unless it matches the document/version creator — a
   * share grant that lets a peer *see* a document never lets them forget or
   * purge it. `deprecateVersion` and `sweepEphemeral` are not HTTP-routed
   * and keep the CL-5871 tenant-only signature.
   */
  deprecateVersion?(input: {
    tenantId: string;
    versionId: string;
    reason?: string;
  }): Promise<{ versionId: string; documentId: string; status: string } | null>;
  tombstoneDocument?(input: {
    tenantId: string;
    principalId: string;
    documentId: string;
    reason?: string;
  }): Promise<{ versions: number }>;
  hardDeleteDocument?(input: {
    tenantId: string;
    principalId: string;
    documentId: string;
  }): Promise<{ deleted: boolean; reason?: string }>;
  sweepEphemeral?(input: {
    tenantId: string;
    now?: Date;
  }): Promise<{ versionsDeprecated: number }>;
  setRetentionClass?(input: {
    tenantId: string;
    principalId: string;
    versionId: string;
    retentionClass: "durable" | "standard" | "ephemeral" | "source_only";
  }): Promise<{ versionId: string; documentId: string; status: string } | null>;
};

export type { TimelineEvent };

export type MemoryOptions = {
  /** Engine config (DB + model endpoints). Required when `documentStore` is omitted. */
  config?: MemoryConfig;
  /**
   * Host Interchange `GrantStore`. Used for document access filtering on
   * search/list. Standalone add-only callers may omit it.
   */
  grantStore?: GrantConfig["grantStore"];
  /**
   * Host Interchange condition evaluators keyed by name. Optional — default
   * `{}` when `grantStore` is set. Same object the hub passes to
   * `createRequireGrant` / `createApp`.
   */
  conditionRegistry?: GrantConfig["conditionRegistry"];
  /** Required for `add({ file })`; omit if the host only adds text content. */
  textExtractor?: TextExtractor;
  /**
   * Override durable storage. When set, the plane does not open Postgres or
   * call embed/rerank endpoints — use for fakes and host DocumentStore
   * backends. When omitted, the default engine DocumentStore is used.
   */
  documentStore?: DocumentStore;
  /**
   * Live source connectors (tools-shaped). Merged into search via
   * MergeLocalLiveV1; not a DocumentStore replacement.
   */
  sources?: SourceProvider[];
};

/** Bundle host authz pieces for route guards and document access. */
export function resolveGrantConfig(
  options: Pick<MemoryOptions, "grantStore" | "conditionRegistry">,
): GrantConfig | undefined {
  if (!options.grantStore) return undefined;
  // Merge memoryShare evaluator under host keys so share grants with
  // conditions are not fail-closed-skipped by @intx/authz.
  return {
    grantStore: options.grantStore,
    conditionRegistry: {
      ...MEMORY_SHARE_CONDITION_REGISTRY,
      ...(options.conditionRegistry ?? {}),
    },
  };
}

function resolveSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_HYBRID_TOP_K;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < SEARCH_LIMIT_MIN ||
    limit > SEARCH_LIMIT_MAX
  ) {
    throw new MemoryError(
      400,
      `limit must be an integer between ${SEARCH_LIMIT_MIN} and ${SEARCH_LIMIT_MAX}`,
    );
  }
  return limit;
}

function resolveListLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < LIST_LIMIT_MIN ||
    limit > LIST_LIMIT_MAX
  ) {
    throw new MemoryError(
      400,
      `limit must be an integer between ${LIST_LIMIT_MIN} and ${LIST_LIMIT_MAX}`,
    );
  }
  return limit;
}

function hitsToSearchItems(
  hits: readonly SearchHit[],
  evidence?: HybridSearchResult["evidence"],
): SearchItem[] {
  return hits.map((h) => ({
    documentId: h.document_id,
    title: h.title,
    snippet: h.snippet,
    score: h.score,
    kind: h.kind,
    citation: h.citation,
    attribution: {
      versionId: h.version_id,
      createdByKind: h.created_by_kind,
      ...(h.generator_agent_id !== undefined
        ? { generatorAgentId: h.generator_agent_id }
        : {}),
      ...(h.provenance !== undefined ? { provenance: h.provenance } : {}),
      ...(h.source_class !== undefined ? { sourceClass: h.source_class } : {}),
      ...(h.temporal_class !== undefined
        ? { temporalClass: h.temporal_class }
        : {}),
      ...(h.occurred_at !== undefined ? { occurredAt: h.occurred_at } : {}),
      ...(h.valid_until !== undefined ? { validUntil: h.valid_until } : {}),
      ...(h.supports !== undefined ? { supports: h.supports } : {}),
      ...(h.contradicts !== undefined ? { contradicts: h.contradicts } : {}),
      ...(h.derived_from !== undefined ? { derivedFrom: h.derived_from } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
    },
  }));
}

/**
 * Resolve access tags for add — share sugar + explicit tags only.
 */
function resolveAddAccessTags(params: MemoryAddParams): string[] {
  return resolveAccessTags({
    principalId: params.principalId,
    tenantId: params.tenantId,
    ...(params.accessTags !== undefined ? { accessTags: params.accessTags } : {}),
    ...(params.share !== undefined ? { share: params.share } : {}),
  });
}

/**
 * Build a memory plane.
 *
 * One product path: every plane is store-backed. When `options.documentStore`
 * is omitted, the default pgvector engine is wrapped as that store. Hosts
 * inject a DocumentStore or fakes the same way — no second plane implementation.
 *
 * - Pass `options.grantStore` for document access filtering on search/list.
 *   `conditionRegistry` is optional (defaults to `{}`).
 * - Rerank config is validated at construction when using the default store.
 * - Pass `options.sources` for live SourceProviders; search merges via
 *   MergeLocalLiveV1 (fail-soft, 800ms timeout, prefer-local dedupe).
 * - Document access uses grant tags via the host GrantStore (not mini-ACL).
 * - Inference is host-owned and ephemeral: call your model, then `add` /
 *   `search`. Core does not run an ingest agent or bake LLM into writes.
 *
 * @example With default pgvector store
 * ```ts
 * const memory = createMemory({
 *   config: loadMemoryConfig(),
 *   grantStore,
 *   conditionRegistry,
 * });
 * ```
 *
 * @example With a host DocumentStore (no Postgres)
 * ```ts
 * const memory = createMemory({
 *   documentStore: myStore,
 *   grantStore,
 * });
 * ```
 */
export function createMemory(options: MemoryOptions = {}): Memory {
  const {
    config,
    grantStore,
    conditionRegistry,
    documentStore,
    textExtractor,
    sources,
  } = options;
  const grants = resolveGrantConfig({
    ...(grantStore !== undefined ? { grantStore } : {}),
    ...(conditionRegistry !== undefined ? { conditionRegistry } : {}),
  });

  let transformDeps: EngineTransformDeps | undefined;
  const store =
    documentStore ??
    (() => {
      if (!config) {
        throw new MemoryError(
          500,
          "config is required when documentStore is not provided",
        );
      }
      const engine = createEngineDocumentStore(config);
      transformDeps = engine.deps;
      return engine.store;
    })();

  return createPlaneFromStore(
    store,
    grants,
    {
      ...(textExtractor ? { textExtractor } : {}),
      ...(sources ? { sources } : {}),
    },
    transformDeps,
  );
}

function wantsLocalChannel(sources: string[] | undefined): boolean {
  return !sources || sources.length === 0 || sources.includes("local");
}

function findItemsToMergeChannel(
  items: SearchItem[],
  channel: "local" | "live",
): MergeChannelItem[] {
  return items.map((item) => ({
    channel,
    adapter: item.citation.adapter,
    externalRef: item.citation.external_ref,
    documentId: item.documentId,
    title: item.title,
    snippet: item.snippet,
    score: item.score,
    kind: item.kind,
    citation: item.citation,
    ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
  }));
}

/**
 * Fan-out to live sources with timeout + allSettled. Never throws for a
 * single source failure — returns items + degrade flags.
 */
async function collectLiveItems(params: {
  sources: SourceProvider[] | undefined;
  query: string;
  tenantId: string;
  principalId: string;
  limit: number;
  filter: string[] | undefined;
}): Promise<{ items: MergeChannelItem[]; degraded: DegradeFlag[] }> {
  const degraded: DegradeFlag[] = [];
  const providers = (params.sources ?? []).filter((s) => {
    if (typeof s.searchLive !== "function") return false;
    if (!params.filter || params.filter.length === 0) return true;
    return params.filter.includes(s.id);
  });
  if (providers.length === 0) return { items: [], degraded };

  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const hits = await withTimeout(
        provider.searchLive!({
          query: params.query,
          tenantId: params.tenantId,
          principalId: params.principalId,
          limit: params.limit,
        }),
        LIVE_TIMEOUT_MS,
        provider.id,
      );
      return { provider, hits };
    }),
  );

  const items: MergeChannelItem[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      const { provider, hits } = result.value;
      for (const hit of hits) {
        items.push({
          channel: "live",
          adapter: hit.adapter || provider.id,
          externalRef: hit.externalRef,
          documentId: hit.externalRef,
          title: hit.title,
          snippet: hit.snippet,
          score: hit.score,
          kind: hit.kind,
          citation: hit.citation,
          ...(hit.updatedAt !== undefined ? { updatedAt: hit.updatedAt } : {}),
        });
      }
    } else {
      const err = result.reason as { code?: string } | undefined;
      const flag: MergeDegradeFlag =
        err && err.code === "live_timeout" ? "live_timeout" : "live_error";
      if (!degraded.includes(flag)) degraded.push(flag);
    }
  }
  return { items, degraded };
}

function mergeToSearchResult(params: {
  localItems: SearchItem[];
  localDegraded?: DegradeFlag[];
  /** Hybrid evidence from the local channel when no live items were active. */
  localEvidence?: HybridSearchResult["evidence"];
  liveItems: MergeChannelItem[];
  liveDegraded: DegradeFlag[];
  limit: number;
  sources?: string[];
  includeEvidence?: boolean;
}): SearchResult {
  const merged = mergeLocalLiveV1({
    local: findItemsToMergeChannel(params.localItems, "local"),
    live: params.liveItems,
    limit: params.limit,
    ...(params.sources !== undefined ? { sources: params.sources } : {}),
  });

  const items: SearchItem[] = merged.items.map((it) => {
    // Preserve local attribution when merge kept a local hit (same documentId).
    const local = params.localItems.find((l) => l.documentId === it.documentId);
    return {
      documentId: it.documentId,
      title: it.title,
      snippet: it.snippet,
      score: it.score,
      kind: it.kind,
      citation: it.citation,
      ...(local?.attribution !== undefined
        ? { attribution: local.attribution }
        : {}),
      ...(local?.updatedAt !== undefined ? { updatedAt: local.updatedAt } : {}),
    };
  });

  const degraded: DegradeFlag[] = [
    ...(params.localDegraded ?? []),
    ...params.liveDegraded,
  ];

  if (params.includeEvidence) {
    // Preserve hybrid strong/weak when live did not contribute hits; mixed or
    // live-only merges stay conservatively "weak".
    const liveContributed = params.liveItems.length > 0;
    let evidence: HybridSearchResult["evidence"];
    if (items.length === 0) {
      evidence = "none";
    } else if (!liveContributed && params.localEvidence) {
      evidence = params.localEvidence;
    } else if (!liveContributed) {
      evidence = "weak";
    } else {
      evidence = "weak";
    }
    return {
      items,
      evidence,
      ...(degraded.length > 0 ? { degraded } : {}),
    };
  }
  // Without includeEvidence, still surface live degrade so hosts can observe
  // fail-soft live failures (local hybrid degrade stays evidence-gated).
  const liveOnly = degraded.filter(
    (d) => d === "live_timeout" || d === "live_error",
  );
  return {
    items,
    ...(liveOnly.length > 0 ? { degraded: liveOnly } : {}),
  };
}

/**
 * Optional personal-memory path removed from product surface.
 * Hosts that need LLM extract-on-add call their own model, then `add`.
 */

/** Plane backed by a DocumentStore. Store owns tenancy and document ACL. */
function createPlaneFromStore(
  store: DocumentStore,
  grants: GrantConfig | undefined,
  options: MemoryOptions,
  transformDeps?: EngineTransformDeps,
): Memory {
  async function searchMerged(
    params: MemorySearchParams,
  ): Promise<SearchResult> {
    const limit = resolveSearchLimit(params.limit);
    let localItems: SearchItem[] = [];
    let localDegraded: DegradeFlag[] | undefined;
    let localEvidence: HybridSearchResult["evidence"] | undefined;

    if (wantsLocalChannel(params.sources)) {
      const local = await store.search({
        tenantId: params.tenantId,
        principalId: params.principalId,
        query: params.query,
        limit,
        includeEvidence: true,
        ...(params.kinds !== undefined ? { kinds: params.kinds } : {}),
        ...(params.entityIds !== undefined
          ? { entityIds: params.entityIds }
          : {}),
        ...(params.includeDeprecated !== undefined
          ? { includeDeprecated: params.includeDeprecated }
          : {}),
        ...(grants !== undefined ? { grants: grants.grantStore } : {}),
        ...(grants?.conditionRegistry !== undefined
          ? { conditionRegistry: grants.conditionRegistry }
          : {}),
      });
      localItems = local.items.map((it) => ({
        documentId: it.documentId,
        title: it.title,
        snippet: it.snippet,
        score: it.score,
        kind: it.kind,
        citation: it.citation,
        ...(it.updatedAt !== undefined ? { updatedAt: it.updatedAt } : {}),
        ...(it.attribution !== undefined
          ? { attribution: it.attribution }
          : {}),
      }));
      localDegraded = local.degraded as DegradeFlag[] | undefined;
      localEvidence = local.evidence;
    }

    const live = await collectLiveItems({
      sources: options.sources,
      query: params.query,
      tenantId: params.tenantId,
      principalId: params.principalId,
      limit,
      filter: params.sources,
    });

    // No live channel activity → preserve store evidence semantics.
    if (
      live.items.length === 0 &&
      live.degraded.length === 0 &&
      (options.sources ?? []).length === 0
    ) {
      if (params.includeEvidence) {
        return {
          items: localItems,
          evidence: localEvidence ?? "none",
          ...(localDegraded ? { degraded: localDegraded } : {}),
        };
      }
      return { items: localItems };
    }

    return mergeToSearchResult({
      localItems,
      ...(localDegraded !== undefined ? { localDegraded } : {}),
      ...(localEvidence !== undefined ? { localEvidence } : {}),
      liveItems: live.items,
      liveDegraded: live.degraded,
      limit,
      ...(params.sources !== undefined ? { sources: params.sources } : {}),
      ...(params.includeEvidence !== undefined
        ? { includeEvidence: params.includeEvidence }
        : {}),
    });
  }

  // A custom store that doesn't report its own capabilities is assumed
  // embeddings-capable — the pre-CL-6287 default, since this SDK cannot
  // introspect a vendor store it doesn't own. The engine store always
  // reports one (see createEngineDocumentStore).
  const capabilities: MemoryCapabilities = store.capabilities ?? {
    embeddingsConfigured: true,
  };

  const plane: Memory = {
    capabilities,

    async search(params) {
      return searchMerged(params);
    },

    async add(params) {
      const hasContent = params.content !== undefined;
      const hasFile = params.file !== undefined;
      if (hasContent === hasFile) {
        throw new MemoryError(
          400,
          "provide exactly one of content or file",
        );
      }

      let title: string;
      let text: string;
      if (params.content) {
        title = params.content.title;
        text = params.content.text;
      } else {
        const file = params.file!;
        if (!options.textExtractor) {
          throw new MemoryError(
            400,
            "file requires a textExtractor on the memory plane",
          );
        }
        const extracted = await options.textExtractor.extract({
          bytes: file.bytes,
          ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
          ...(file.filename !== undefined ? { filename: file.filename } : {}),
        });
        text = extracted.text;
        title =
          file.title ?? extracted.title ?? file.filename ?? "untitled";
      }

      const accessTags = resolveAddAccessTags(params);

      const externalRef =
        params.externalRef ??
        `memory:${params.tenantId}:${crypto.randomUUID()}`;

      const result = await store.add({
        tenantId: params.tenantId,
        principalId: params.principalId,
        title,
        text,
        accessTags,
        externalRef,
        ...(params.attributes !== undefined
          ? { attributes: params.attributes }
          : {}),
        ...(params.adapter !== undefined ? { adapter: params.adapter } : {}),
        ...(params.kind !== undefined ? { kind: params.kind } : {}),
        ...(params.generatorAgentId !== undefined
          ? { generatorAgentId: params.generatorAgentId }
          : {}),
        ...(params.provenance !== undefined
          ? { provenance: params.provenance }
          : {}),
        ...(params.lineageClass !== undefined
          ? { lineageClass: params.lineageClass }
          : {}),
        ...(params.temporalClass !== undefined
          ? { temporalClass: params.temporalClass }
          : {}),
        ...(params.derivedFrom !== undefined
          ? { derivedFrom: params.derivedFrom }
          : {}),
        ...(params.validFrom !== undefined
          ? { validFrom: params.validFrom }
          : {}),
        ...(params.validUntil !== undefined
          ? { validUntil: params.validUntil }
          : {}),
      });

      // Share materialization (CL-5873): stamp document-scoped tag + write
      // peer grants when the host store is writable. Tag mint alone is not
      // enough for peers without host bootstrap grants on owner tags. The
      // document is already durably committed by store.add() above, so a
      // failure here must not throw (that would surface as add() failing
      // for a document that in fact exists, inviting a caller retry that
      // creates a duplicate) — it downgrades grantsMaterialized instead.
      // grantsMaterialized is only ever true when BOTH the access tag was
      // actually stamped AND the peer grant was actually written; either
      // alone leaves canAccessDocument unable to find a match for peers.
      let grantsMaterialized: boolean | undefined;
      const peers = params.share?.principals;
      if (peers && peers.length > 0) {
        grantsMaterialized = false;
        try {
          const docTag = documentTag(result.documentId);
          let tagStamped = false;
          if (store.appendAccessTags) {
            await store.appendAccessTags(params.tenantId, result.documentId, [docTag]);
            tagStamped = true;
          } else {
            log.warn(
              "memory.add: share.principals set but DocumentStore has no appendAccessTags; peer grants may not match",
              { documentId: result.documentId },
            );
          }
          if (isWritableGrantStore(grants?.grantStore)) {
            await materializeShareGrants(grants.grantStore, {
              tenantId: params.tenantId,
              sharedByPrincipalId: params.principalId,
              documentId: result.documentId,
              sourceVersionId: result.versionId,
              share: params.share ?? {},
            });
            grantsMaterialized = tagStamped;
          } else {
            log.warn(
              "memory.add: share.principals set without WritableGrantStore; tags only (peers need host grants)",
              { documentId: result.documentId },
            );
          }
        } catch (err) {
          log.error(
            "memory.add: share materialization failed after document commit; peers may not have access",
            { documentId: result.documentId, error: formatCaughtError(err) },
          );
          grantsMaterialized = false;
        }
      }

      return grantsMaterialized === undefined
        ? result
        : { ...result, grantsMaterialized };
    },

    async list(params) {
      const limit = resolveListLimit(params.limit);
      return store.list({
        tenantId: params.tenantId,
        principalId: params.principalId,
        ...(limit !== undefined ? { limit } : {}),
        ...(grants !== undefined ? { grants: grants.grantStore } : {}),
        ...(grants?.conditionRegistry !== undefined
          ? { conditionRegistry: grants.conditionRegistry }
          : {}),
      });
    },

    async feed(params) {
      if (!store.feed) {
        throw new MemoryError(
          501,
          "feed requires the engine DocumentStore",
        );
      }
      return store.feed({
        tenantId: params.tenantId,
        principalId: params.principalId,
        ...(params.after !== undefined ? { after: params.after } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.excludeGenerator !== undefined
          ? { excludeGenerator: params.excludeGenerator }
          : {}),
        ...(grants !== undefined ? { grants: grants.grantStore } : {}),
        ...(grants?.conditionRegistry !== undefined
          ? { conditionRegistry: grants.conditionRegistry }
          : {}),
      });
    },

    async close() {
      await store.close();
    },

    async createTransformConfig(input) {
      if (!transformDeps) {
        throw new MemoryError(
          501,
          "transform APIs require the engine DocumentStore",
        );
      }
      return createTransformConfig({ db: transformDeps.db }, input);
    },

    async listTransformConfigs(tenantId) {
      if (!transformDeps) {
        throw new MemoryError(
          501,
          "transform APIs require the engine DocumentStore",
        );
      }
      return listTransformConfigs({ db: transformDeps.db }, tenantId);
    },

    async runTransform(input) {
      if (!transformDeps) {
        throw new MemoryError(
          501,
          "transform APIs require the engine DocumentStore",
        );
      }
      return runTransform(transformDeps, input);
    },

    async promoteGeneration(input) {
      if (!transformDeps) {
        throw new MemoryError(
          501,
          "transform APIs require the engine DocumentStore",
        );
      }
      return promoteGeneration(transformDeps, input);
    },

    async demoteGeneration(input) {
      if (!transformDeps) {
        throw new MemoryError(
          501,
          "transform APIs require the engine DocumentStore",
        );
      }
      return demoteGeneration(transformDeps, input);
    },

    async deprecateVersion(input) {
      if (!transformDeps) {
        throw new MemoryError(
          501,
          "retention APIs require the engine DocumentStore",
        );
      }
      return deprecateVersion(transformDeps.db, input);
    },

    async tombstoneDocument(input) {
      if (!transformDeps) {
        throw new MemoryError(
          501,
          "retention APIs require the engine DocumentStore",
        );
      }
      const owner = await resolveDocumentOwner(transformDeps.sql, input);
      if (!owner.exists) {
        throw new MemoryError(404, "document not found");
      }
      if (!isOwner(owner, input.principalId)) {
        throw new MemoryError(
          403,
          "only the document's creator may forget it",
        );
      }
      return tombstoneDocument(transformDeps.db, input);
    },

    async hardDeleteDocument(input) {
      if (!transformDeps) {
        throw new MemoryError(
          501,
          "retention APIs require the engine DocumentStore",
        );
      }
      const owner = await resolveDocumentOwner(transformDeps.sql, input);
      if (!owner.exists) {
        throw new MemoryError(404, "document not found");
      }
      if (!isOwner(owner, input.principalId)) {
        throw new MemoryError(
          403,
          "only the document's creator may purge it",
        );
      }
      return hardDeleteDocument(transformDeps.db, input);
    },

    async sweepEphemeral(input) {
      if (!transformDeps) {
        throw new MemoryError(
          501,
          "retention APIs require the engine DocumentStore",
        );
      }
      return sweepEphemeral(transformDeps.db, input);
    },

    async setRetentionClass(input) {
      if (!transformDeps) {
        throw new MemoryError(
          501,
          "retention APIs require the engine DocumentStore",
        );
      }
      const owner = await resolveVersionOwner(transformDeps.sql, input);
      if (!owner.exists) {
        throw new MemoryError(404, "version not found");
      }
      if (!isOwner(owner, input.principalId)) {
        throw new MemoryError(
          403,
          "only the version's creator may change its retention class",
        );
      }
      return setRetentionClass(transformDeps.db, input);
    },
  };

  return plane;
}

type EngineTransformDeps = {
  db: Db;
  sql: RawSql;
  config: EngineConfig;
};

/**
 * Default DocumentStore: engine pgvector + hybrid search + timeline.
 * Owns construction-time rerank validation, FTS verification, and grant-tag
 * post-filter for document access. The plane never opens Postgres itself.
 */
function createEngineDocumentStore(config: MemoryConfig): {
  store: DocumentStore;
  deps: EngineTransformDeps;
} {
  // Catch a chunk-size / reranker-limit mismatch at construction time, rather
  // than silently on every find once the reranker starts rejecting batches.
  // Throws instead of warning: a mismatch means every rerank call for this
  // host WILL 413 and silently degrade to fused ranking, with no per-request
  // signal — a construction-time failure surfaces that once, loudly.
  // Safe to throw because the per-model default budget
  // (`defaultMaxDocCharsForModel`) is self-consistent by construction —
  // validation can only fire on an operator's own `maxDocChars` override,
  // never spuriously on an unmodified config.
  // Lives here (not only in createMemory with app) so standalone construction
  // cannot silently degrade on a bad override.
  const rerankConfig = toRerankClientConfig(config.memory.rerank);
  if (rerankConfig) validateRerankConfig(rerankConfig);

  // Resolve once here so EngineConfig.ftsLanguage is concrete for every
  // service — loadMemoryConfig already runs parseFtsLanguage, but a
  // hand-built EngineConfig may still carry an empty/absent value; this is
  // the single defaulting site services rely on.
  const engineConfig: EngineConfig = {
    ...config.memory,
    ftsLanguage: parseFtsLanguage(config.memory.ftsLanguage),
  };
  const { db, sql }: { db: Db; sql: RawSql } = createDb(engineConfig);
  const deps = { db, sql, config: engineConfig };

  // Serving-path schema validation, industry-standard fail-fast shape
  // (Hibernate validate / Rails check_all_pending!): the mount is
  // synchronous, so "before accepting traffic" becomes a memoized check
  // awaited by the first query. Read-only; migration stays a deploy step.
  // NOTE this is a lazy check, not a boot-time one: nothing forces it to run
  // until the first real find()/add() call, so a host that neither
  // runs runMemoryMigrations itself nor wires a readiness probe will not
  // learn about a language mismatch until that first call fails. A host
  // that wants a real boot-time guarantee MUST call the exported
  // verifyFtsLanguage from its own readiness probe — this memo then
  // resolves instantly against the already-verified schema.
  const ensureVerified = createFtsVerification(
    createRawSqlClient(sql),
    engineConfig.ftsLanguage,
  );

  /**
   * Hybrid retrieval + grant-tag post-filter (security boundary).
   * Returns the full HybridSearchResult so evidence/degrade pass through.
   */
  async function retrieve(params: {
    tenantId: string;
    principalId: string;
    query: string;
    k?: number;
    kinds?: string[];
    entityIds?: string[];
    includeDeprecated?: boolean;
    grants?: DocumentStoreSearchParams["grants"];
    conditionRegistry?: DocumentStoreSearchParams["conditionRegistry"];
  }): Promise<HybridSearchResult> {
    try {
      await ensureVerified();
      const result = await hybridSearch(deps, {
        tenantId: params.tenantId,
        principalId: params.principalId,
        query: params.query,
        ...(params.k !== undefined ? { k: params.k } : {}),
        ...(params.kinds !== undefined ? { kinds: params.kinds } : {}),
        ...(params.entityIds !== undefined
          ? { entityIds: params.entityIds }
          : {}),
        ...(params.includeDeprecated !== undefined
          ? { includeDeprecated: params.includeDeprecated }
          : {}),
      });

      if (result.hits.length === 0) return result;
      const docIds = Array.from(
        new Set(result.hits.map((h) => h.document_id)),
      );

      // Load access_tags + active-version creator for grant-tag check.
      // Raw SQL so unit tests can mock `sql` without a real drizzle client.
      const rows = await sql<
        {
          id: string;
          access_tags: string[] | null;
          created_by: string | null;
        }[]
      >`
          SELECT d.id,
                 d.access_tags,
                 v.created_by_principal_id AS created_by
          FROM "memory"."document" d
          LEFT JOIN "memory"."version" v
            ON v.document_id = d.id
           AND v.status = 'active'
           AND v.generation = 'live'
          WHERE d.id = ANY(${docIds}::text[])
        `;

      const byId = new Map(
        rows.map((r) => [
          r.id,
          {
            accessTags: (r.access_tags ?? []) as string[],
            createdByPrincipalId: r.created_by,
          },
        ]),
      );

      const allowed = new Set<string>();
      for (const id of docIds) {
        const meta = byId.get(id);
        if (!meta) continue;
        // No grants → creator-only (safe default for standalone / unit tests).
        if (!params.grants) {
          if (meta.createdByPrincipalId === params.principalId) {
            allowed.add(id);
          }
          continue;
        }
        const ok = await canAccessDocument({
          grants: params.grants,
          tenantId: params.tenantId,
          principalId: params.principalId,
          createdByPrincipalId: meta.createdByPrincipalId,
          accessTags: meta.accessTags,
          ...(params.conditionRegistry !== undefined
            ? { conditionRegistry: params.conditionRegistry }
            : {}),
        });
        if (ok) allowed.add(id);
      }

      const hits = result.hits.filter((h) => allowed.has(h.document_id));
      return {
        ...result,
        hits,
        evidence: hits.length === 0 ? "none" : result.evidence,
      };
    } catch (err) {
      if (err instanceof MemorySearchInputError) {
        throw new MemoryError(400, err.message);
      }
      throw err;
    }
  }

  return {
    store: {
      async add(params) {
        await ensureVerified();

        const adapter = params.adapter ?? "http";
        const externalRef =
          params.externalRef ??
          `memory:${params.tenantId}:${crypto.randomUUID()}`;
        const accessTags = params.accessTags ?? [ownerTag(params.principalId)];

        const generatorAgentId = params.generatorAgentId?.trim() || undefined;
        const actor = generatorAgentId
          ? {
              kind: "agent" as const,
              agentId: generatorAgentId,
              principalId: params.principalId,
            }
          : { kind: "human" as const, principalId: params.principalId };

        const edges =
          params.derivedFrom && params.derivedFrom.length > 0
            ? params.derivedFrom.map((versionId) => ({
                rel: "derived_from" as const,
                to: { type: "version" as const, ref: versionId },
              }))
            : undefined;

        const captureResult = await captureDocument(deps, {
          tenantId: params.tenantId,
          adapter,
          occurredAt: new Date().toISOString(),
          document: {
            kind: params.kind ?? "note",
            title: params.title,
            externalRef,
            accessTags,
            entityHints: [],
            chunks: [{ ordinal: 0, text: params.text }],
            actor,
            contentHash: "", // recomputed canonically in adapt-and-plan
            ...(params.attributes !== undefined
              ? { attributes: params.attributes }
              : {}),
            ...(params.provenance !== undefined
              ? { provenance: params.provenance }
              : generatorAgentId
                ? { provenance: "inferred" as const }
                : {}),
            ...(params.lineageClass !== undefined
              ? { lineageClass: params.lineageClass }
              : generatorAgentId
                ? { lineageClass: "derived" as const }
                : {}),
            ...(params.temporalClass !== undefined
              ? { temporalClass: params.temporalClass }
              : {}),
            ...(params.validFrom !== undefined
              ? { validFrom: params.validFrom }
              : {}),
            ...(params.validUntil !== undefined
              ? { validUntil: params.validUntil }
              : {}),
            ...(edges !== undefined ? { edges } : {}),
          },
        });
        return {
          documentId: captureResult.documentId,
          versionId: captureResult.versionId,
          ...(captureResult.status === "captured" && captureResult.degraded
            ? { degraded: captureResult.degraded }
            : {}),
        };
      },

      async appendAccessTags(tenantId, documentId, tags) {
        if (tags.length === 0) return;
        // Union into existing access_tags array (postgres text[]). Tenant
        // filter is defense-in-depth against a forged documentId.
        await sql`
          UPDATE "memory"."document"
          SET access_tags = (
            SELECT ARRAY(
              SELECT DISTINCT t
              FROM unnest(
                COALESCE(access_tags, '{}'::text[]) || ${[...tags]}::text[]
              ) AS t
            )
          )
          WHERE id = ${documentId}
            AND tenant_id = ${tenantId}
        `;
      },

      async search(params) {
        const result = await retrieve({
          tenantId: params.tenantId,
          principalId: params.principalId,
          query: params.query,
          ...(params.limit !== undefined ? { k: params.limit } : {}),
          ...(params.kinds !== undefined ? { kinds: params.kinds } : {}),
          ...(params.entityIds !== undefined
            ? { entityIds: params.entityIds }
            : {}),
          ...(params.includeDeprecated !== undefined
            ? { includeDeprecated: params.includeDeprecated }
            : {}),
          ...(params.grants !== undefined ? { grants: params.grants } : {}),
          ...(params.conditionRegistry !== undefined
            ? { conditionRegistry: params.conditionRegistry }
            : {}),
        });
        const items = hitsToSearchItems(result.hits, result.evidence);
        if (params.includeEvidence) {
          return {
            items,
            evidence: result.evidence,
            ...(result.degraded ? { degraded: result.degraded } : {}),
          };
        }
        return {
          items,
          ...(result.degraded ? { degraded: result.degraded } : {}),
        };
      },

      async list(params) {
        return listTimelineEvents({
          db,
          tenantId: params.tenantId,
          principalId: params.principalId,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.grants !== undefined ? { grants: params.grants } : {}),
          ...(params.conditionRegistry !== undefined
            ? { conditionRegistry: params.conditionRegistry }
            : {}),
        });
      },

      async feed(params) {
        await ensureVerified();
        const raw = await fetchFeed(db, {
          tenantId: params.tenantId,
          ...(params.after !== undefined ? { after: params.after } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.excludeGenerator !== undefined
            ? { excludeGenerator: params.excludeGenerator }
            : {}),
        });

        const allowed: FeedEntry[] = [];
        for (const entry of raw.entries) {
          if (!params.grants) {
            if (entry.createdByPrincipalId === params.principalId) {
              allowed.push(entry);
            }
            continue;
          }
          const ok = await canAccessDocument({
            grants: params.grants,
            tenantId: params.tenantId,
            principalId: params.principalId,
            createdByPrincipalId: entry.createdByPrincipalId,
            accessTags: entry.accessTags,
            ...(params.conditionRegistry !== undefined
              ? { conditionRegistry: params.conditionRegistry }
              : {}),
          });
          if (ok) allowed.push(entry);
        }

        const entries = allowed.map((e) => ({
          feedSeq: e.feedSeq,
          versionId: e.versionId,
          documentId: e.documentId,
          kind: e.kind,
          title: e.title,
          status: e.status,
          createdByKind: e.createdByKind,
          generatorAgentId: e.generatorAgentId,
          provenance: e.provenance,
          occurredAt: e.occurredAt,
          createdAt: e.createdAt,
          accessTags: e.accessTags,
        }));
        // nextCursor must advance past the *raw* page even when ACL filters
        // every entry — otherwise a denied page stalls the consumer forever.
        return feedPageAfterAccessFilter(raw, entries);
      },

      async close() {
        await sql.end({ timeout: 5 });
      },

      capabilities: { embeddingsConfigured: Boolean(engineConfig.embed) },
    },
    deps,
  };
}
