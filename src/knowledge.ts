/**
 * Knowledge plane backed by the engine's pgvector Postgres. Wraps the capture
 * and hybrid-search services directly — no HTTP hop.
 *
 * Green surface: add / find / ask / recent.
 */
import { authorize } from "@intx/authz";

import { blockedDocumentIds } from "./acl.ts";
import type { EngineConfig } from "./config.ts";
import { log } from "./log.ts";
import { createDb, type Db, type RawSql } from "./db/client.ts";
import { createFtsVerification, parseFtsLanguage } from "./core/fts-language.ts";
import { createRawSqlClient } from "./core/embed-sql.ts";
import type { VisibilitySpec } from "./core/schemas/document.ts";
import type { SearchHit } from "./core/schemas/search.ts";
import { validateRerankConfig } from "./core/rerank-client.ts";
import { captureDocument } from "./services/capture.ts";
import {
  hybridSearch,
  KnowledgeSearchInputError,
  toRerankClientConfig,
  type HybridSearchResult,
  DEFAULT_HYBRID_TOP_K,
} from "./services/search.ts";
import {
  listTimelineEvents,
  type TimelineEvent,
  DEFAULT_TIMELINE_LIMIT,
} from "./services/timeline.ts";
import {
  LIVE_TIMEOUT_MS,
  mergeLocalLiveV1,
  withTimeout,
  type MergeChannelItem,
  type MergeDegradeFlag,
} from "./core/merge-local-live.ts";
import type { DegradeFlag } from "./core/hybrid-search.ts";
import type { KnowledgeConfig } from "./mount-config.ts";
import type { GrantConfig } from "./routes/deps.ts";
import type {
  DocumentStore,
  MemoryProvider,
  SourceProvider,
} from "./ports/types.ts";

// Re-export so hosts typing plane results don't reach into services/.
export type { HybridSearchResult } from "./services/search.ts";
export type { SearchHit } from "./core/schemas/search.ts";
export type { VisibilitySpec } from "./core/schemas/document.ts";
export type {
  DocumentStore,
  DocumentStoreAddParams,
  LiveSearchItem,
  MemoryProvider,
  SourceProvider,
} from "./ports/types.ts";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * How `ask()` reaches a model. Supplied by the host, not owned here.
 *
 * The engine deliberately has no generation client. Interchange already has an
 * inference layer (`@intx/inference`) with provider adapters, tenant-scoped
 * credentials, retry policy, audit and authz gates — hand-rolling a `fetch` here
 * would bypass all of it and take an API key from a raw env var. Hosts wire
 * this to that layer; tests pass a stub.
 *
 * Same posture the engine already takes on embedding: never in-process, always
 * an endpoint the owner plugs in.
 */
export type Generate = (messages: readonly ChatMessage[]) => Promise<string>;

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

export type KnowledgeIdentity = {
  principalId: string;
  tenantId: string;
};

/** Green find limit bounds (stricter than hybridSearch's internal MAX_K). */
export const FIND_LIMIT_MIN = 1;
export const FIND_LIMIT_MAX = 50;

/** Green recent limit bounds (matches timeline service default/cap). */
export const RECENT_LIMIT_MIN = 1;
export const RECENT_LIMIT_MAX = DEFAULT_TIMELINE_LIMIT;

export type KnowledgeFindParams = KnowledgeIdentity & {
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
};

export type KnowledgeAskParams = KnowledgeIdentity & {
  query: string;
  limit?: number;
  /** Same channel filter as find (passed through). */
  sources?: string[];
  /**
   * When true and a MemoryProvider is mounted, recall personal memory into
   * the ask context. Default false — memory is opt-in per call.
   */
  includeMemory?: boolean;
};

/** One source cited in an `ask()` answer, matched to its bracket in the text. */
export type AskCitation = {
  /** The `[N]` marker the grounding prompt asked the model to cite. */
  index: number;
  documentId: string;
  title: string;
  citation: SearchHit["citation"];
};

export type AskResult = {
  text: string;
  citations: AskCitation[];
  evidence: HybridSearchResult["evidence"];
  /** Present when memory/live stages degraded (ask still answered). */
  degraded?: HybridSearchResult["degraded"];
};

/** Thrown when the asking principal lacks the knowledge:find capability. */
export class KnowledgeNotPermittedError extends Error {
  constructor() {
    super("principal lacks the knowledge:find grant");
    this.name = "KnowledgeNotPermittedError";
  }
}

export type KnowledgeShare =
  | { mode: "private" }
  | { mode: "tenant" }
  | { mode: "principals"; principalIds: string[] };

export type KnowledgeAddParams = KnowledgeIdentity & {
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
  /** Direct escape hatch; mutually exclusive with `share`. */
  visibility?: VisibilitySpec;
  /** Direct escape hatch; with `share`, use `share.block` instead. */
  blockPrincipalIds?: string[];
  /**
   * Sugar for visibility + optional block list.
   * Mutually exclusive with `visibility`.
   */
  share?: KnowledgeShare & { block?: string[] };
  attributes?: Record<string, string | number | boolean | null>;
};

export type KnowledgeAddResult = { documentId: string };

export type FindItem = {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
  kind: string;
  citation: SearchHit["citation"];
};

export type FindResult = {
  items: FindItem[];
  /** Only present when includeEvidence: true */
  evidence?: "strong" | "weak" | "none";
  degraded?: HybridSearchResult["degraded"];
};

export type KnowledgeRecentParams = KnowledgeIdentity & {
  limit?: number;
};

export class KnowledgeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}

export type KnowledgePlane = {
  find(params: KnowledgeFindParams): Promise<FindResult>;
  ask(params: KnowledgeAskParams): Promise<AskResult>;
  add(params: KnowledgeAddParams): Promise<KnowledgeAddResult>;
  recent(params: KnowledgeRecentParams): Promise<TimelineEvent[]>;
  /**
   * Write a memory fact for a principal. Requires a mounted MemoryProvider;
   * throws 501 when memory is not configured. Never called implicitly by ask.
   */
  remember(params: KnowledgeRememberParams): Promise<void>;
  /**
   * Recall memory facts for a principal. Empty array when memory is not
   * configured or nothing matches.
   */
  recall(params: KnowledgeRecallParams): Promise<KnowledgeRecallItem[]>;
  close(): Promise<void>;
};

export type KnowledgeRememberParams = KnowledgeIdentity & {
  text: string;
  metadata?: Record<string, string>;
};

export type KnowledgeRecallParams = KnowledgeIdentity & {
  query: string;
  limit?: number;
};

export type KnowledgeRecallItem = {
  text: string;
  score?: number;
};

export type { TimelineEvent };

// Character budget for the grounded context block handed to the generation
// endpoint. Deliberately conservative: it bounds prompt size regardless of
// how many/large the retrieved hits are.
const MAX_CONTEXT_CHARS = 8_000;

const SYSTEM_PROMPT = [
  "You are a knowledge assistant answering questions from retrieved context.",
  "",
  "Answer ONLY from the numbered context provided. The context has already",
  "been filtered to what this specific principal is permitted to read, so",
  "never speculate beyond it or fill gaps from your own knowledge.",
  "",
  "If the context does not contain the answer, say so plainly in one sentence",
  "and stop — do not guess.",
  "",
  "Cite the sources you used as bracketed numbers, e.g. [1] or [2]. Be",
  "concise: a few sentences.",
].join("\n");

/** Build the grounded context block, truncated to a sane prompt budget. */
function buildContext(hits: readonly SearchHit[]): {
  block: string;
  citations: AskCitation[];
} {
  const citations: AskCitation[] = [];
  const parts: string[] = [];
  let budget = MAX_CONTEXT_CHARS;

  // Number only among entries that actually land in the prompt. Skipping an
  // empty snippet (or stopping on budget) must not leave gaps in [N] markers.
  let nextIndex = 1;
  for (const hit of hits) {
    const text = hit.snippet.trim();
    if (!text) continue;
    const index = nextIndex;
    const entry = `[${index}] ${hit.title}\n${text}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    parts.push(entry);
    citations.push({
      index,
      documentId: hit.document_id,
      title: hit.title,
      citation: hit.citation,
    });
    nextIndex += 1;
  }

  return { block: parts.join("\n\n"), citations };
}

/**
 * Turn a search result into an answer: assemble grounded context, call the
 * configured generation endpoint, and return the citations actually used.
 * Factored out of `ask()` so it is unit-testable against a mocked generation
 * endpoint without a real search result / database.
 *
 * Optional `memoryTexts` are prepended as uncited personal context when the
 * host opted into includeMemory. They never produce citations.
 */
export async function synthesizeAnswer(
  query: string,
  result: Pick<HybridSearchResult, "hits" | "evidence">,
  generate: Generate,
  memoryTexts: readonly string[] = [],
): Promise<AskResult> {
  if (result.hits.length === 0 && memoryTexts.length === 0) {
    return {
      text: "I couldn't find anything you have access to that answers that.",
      citations: [],
      evidence: "none",
    };
  }

  const { block, citations } = buildContext(result.hits);
  const memoryBlock =
    memoryTexts.length > 0
      ? "Personal memory:\n" +
        memoryTexts.map((t, i) => `- (m${i + 1}) ${t}`).join("\n")
      : "";

  if (!block && !memoryBlock) {
    return {
      text: "I found matching documents but couldn't read any text out of them.",
      citations: [],
      evidence: "none",
    };
  }

  const contextParts = [memoryBlock, block].filter(Boolean);
  const text = await generate([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Question: ${query}\n\nContext:\n${contextParts.join("\n\n")}`,
    },
  ]);

  return {
    text,
    citations,
    evidence:
      result.hits.length === 0
        ? "weak"
        : result.evidence,
  };
}

export type KnowledgePlaneOptions = {
  /** Required for `ask()`; omit if the host only adds and finds. */
  generate?: Generate;
  /** Required for `add({ file })`; omit if the host only adds text content. */
  textExtractor?: TextExtractor;
  /**
   * Override durable storage. When set, the plane does not open Postgres or
   * call embed/rerank endpoints — useful for fakes and alternate backends.
   */
  documentStore?: DocumentStore;
  /**
   * Live source connectors. Wired into find/ask merge in CL-5227; accepted
   * here so mounts can declare them early.
   */
  sources?: SourceProvider[];
  /**
   * Memory port type accepted for mount wiring; remember/recall product is M3.
   */
  memory?: MemoryProvider;
};

function resolveFindLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_HYBRID_TOP_K;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < FIND_LIMIT_MIN ||
    limit > FIND_LIMIT_MAX
  ) {
    throw new KnowledgeError(
      400,
      `limit must be an integer between ${FIND_LIMIT_MIN} and ${FIND_LIMIT_MAX}`,
    );
  }
  return limit;
}

function resolveRecentLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < RECENT_LIMIT_MIN ||
    limit > RECENT_LIMIT_MAX
  ) {
    throw new KnowledgeError(
      400,
      `limit must be an integer between ${RECENT_LIMIT_MIN} and ${RECENT_LIMIT_MAX}`,
    );
  }
  return limit;
}

function hitsToFindItems(hits: readonly SearchHit[]): FindItem[] {
  return hits.map((h) => ({
    documentId: h.document_id,
    title: h.title,
    snippet: h.snippet,
    score: h.score,
    kind: h.kind,
    citation: h.citation,
  }));
}

/** Map FindItems back to the minimal SearchHit shape synthesizeAnswer needs. */
function findItemsToHits(items: readonly FindItem[]): SearchHit[] {
  return items.map((item) => ({
    chunk_id: "",
    document_id: item.documentId,
    version: 0,
    version_id: "",
    status: "active" as const,
    score: item.score,
    title: item.title,
    snippet: item.snippet,
    kind: item.kind,
    created_by_kind: "human" as const,
    citation: item.citation,
    entity_ids: [],
    channels_matched: [],
  }));
}

function resolveShareAndVisibility(params: KnowledgeAddParams): {
  visibility: VisibilitySpec;
  blockPrincipalIds?: string[];
} {
  if (params.share !== undefined && params.visibility !== undefined) {
    throw new KnowledgeError(
      400,
      "provide share or visibility, not both",
    );
  }

  if (params.share !== undefined) {
    if (params.blockPrincipalIds !== undefined) {
      throw new KnowledgeError(
        400,
        "provide share.block or blockPrincipalIds, not both",
      );
    }
    const share = params.share;
    let visibility: VisibilitySpec;
    if (share.mode === "private") {
      visibility = {
        mode: "private",
        principalIds: [params.principalId],
      };
    } else if (share.mode === "tenant") {
      visibility = { mode: "tenant" };
    } else {
      const ids = new Set(share.principalIds);
      ids.add(params.principalId);
      visibility = { mode: "principals", principalIds: [...ids] };
    }
    const block = share.block;
    return {
      visibility,
      ...(block && block.length > 0 ? { blockPrincipalIds: block } : {}),
    };
  }

  return {
    visibility: params.visibility ?? { mode: "tenant" as const },
    ...(params.blockPrincipalIds !== undefined
      ? { blockPrincipalIds: params.blockPrincipalIds }
      : {}),
  };
}

/**
 * Build a knowledge plane.
 *
 * - `grants` is required for `ask()` (in-process capability check). Standalone
 *   add/find callers may omit it — same as #8's out-of-band plane.
 * - Rerank config is validated at construction (same as mount) when using the
 *   default Postgres-backed store.
 * - Pass `options.documentStore` to skip Postgres entirely (fakes / overrides).
 *   When a store is provided, `config` may be omitted.
 * - Pass `options.sources` for live SourceProviders; find/ask merge via
 *   MergeLocalLiveV1 (fail-soft, 800ms timeout, prefer-local dedupe).
 */
export function createKnowledgePlane(
  config: KnowledgeConfig | undefined,
  grants?: GrantConfig,
  options: KnowledgePlaneOptions = {},
): KnowledgePlane {
  if (options.documentStore) {
    return createPlaneFromStore(options.documentStore, grants, options);
  }
  if (!config) {
    throw new KnowledgeError(
      500,
      "KnowledgeConfig is required when documentStore is not provided",
    );
  }
  return createPlaneFromEngine(config, grants, options);
}

function wantsLocalChannel(sources: string[] | undefined): boolean {
  return !sources || sources.length === 0 || sources.includes("local");
}

function findItemsToMergeChannel(
  items: FindItem[],
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

function mergeToFindResult(params: {
  localItems: FindItem[];
  localDegraded?: DegradeFlag[];
  liveItems: MergeChannelItem[];
  liveDegraded: DegradeFlag[];
  limit: number;
  sources?: string[];
  includeEvidence?: boolean;
}): FindResult {
  const merged = mergeLocalLiveV1({
    local: findItemsToMergeChannel(params.localItems, "local"),
    live: params.liveItems,
    limit: params.limit,
    ...(params.sources !== undefined ? { sources: params.sources } : {}),
  });

  const items: FindItem[] = merged.items.map((it) => ({
    documentId: it.documentId,
    title: it.title,
    snippet: it.snippet,
    score: it.score,
    kind: it.kind,
    citation: it.citation,
  }));

  const degraded: DegradeFlag[] = [
    ...(params.localDegraded ?? []),
    ...params.liveDegraded,
  ];

  if (params.includeEvidence) {
    return {
      items,
      evidence: items.length === 0 ? "none" : "weak",
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
 * Optional memory recall for ask. Never throws — failures become
 * memory_unavailable degrade. Does not call remember (host-owned writes only).
 */
async function recallForAsk(params: {
  memory: MemoryProvider | undefined;
  includeMemory: boolean | undefined;
  tenantId: string;
  principalId: string;
  query: string;
}): Promise<{ texts: string[]; degraded: DegradeFlag[] }> {
  if (!params.includeMemory || !params.memory) {
    return { texts: [], degraded: [] };
  }
  try {
    const items = await params.memory.recall({
      tenantId: params.tenantId,
      principalId: params.principalId,
      query: params.query,
    });
    return {
      texts: items.map((i) => i.text).filter((t) => t.trim().length > 0),
      degraded: [],
    };
  } catch (err) {
    log.warn("ask: memory recall failed; continuing docs-only", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { texts: [], degraded: ["memory_unavailable"] };
  }
}

function makeRememberRecall(options: KnowledgePlaneOptions): {
  remember: KnowledgePlane["remember"];
  recall: KnowledgePlane["recall"];
} {
  return {
    async remember(params) {
      if (!options.memory) {
        throw new KnowledgeError(
          501,
          "remember() requires a MemoryProvider. Pass memory to " +
            "createKnowledgePlane/mountKnowledgeEngine.",
        );
      }
      await options.memory.remember({
        tenantId: params.tenantId,
        principalId: params.principalId,
        text: params.text,
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      });
    },
    async recall(params) {
      if (!options.memory) return [];
      return options.memory.recall({
        tenantId: params.tenantId,
        principalId: params.principalId,
        query: params.query,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
  };
}

/** Plane backed by an injected DocumentStore (fake or host override). */
function createPlaneFromStore(
  store: DocumentStore,
  grants: GrantConfig | undefined,
  options: KnowledgePlaneOptions,
): KnowledgePlane {
  const memoryApi = makeRememberRecall(options);

  async function findMerged(
    params: KnowledgeFindParams,
  ): Promise<FindResult> {
    const limit = resolveFindLimit(params.limit);
    let localItems: FindItem[] = [];
    if (wantsLocalChannel(params.sources)) {
      const local = await store.find({
        tenantId: params.tenantId,
        principalId: params.principalId,
        query: params.query,
        limit,
        includeEvidence: true,
      });
      localItems = local.items.map((it) => ({
        documentId: it.documentId,
        title: it.title,
        snippet: it.snippet,
        score: it.score,
        kind: it.kind,
        citation: it.citation,
      }));
    }

    const live = await collectLiveItems({
      sources: options.sources,
      query: params.query,
      tenantId: params.tenantId,
      principalId: params.principalId,
      limit,
      filter: params.sources,
    });

    return mergeToFindResult({
      localItems,
      liveItems: live.items,
      liveDegraded: live.degraded,
      limit,
      ...(params.sources !== undefined ? { sources: params.sources } : {}),
      ...(params.includeEvidence !== undefined
        ? { includeEvidence: params.includeEvidence }
        : {}),
    });
  }

  const plane: KnowledgePlane = {
    async find(params) {
      return findMerged(params);
    },

    async ask(params) {
      if (!grants) {
        throw new KnowledgeError(
          501,
          "ask() requires a GrantConfig. Pass grants to " +
            "createKnowledgePlane/mountKnowledgeEngine.",
        );
      }
      const decision = await authorize(
        grants.grantStore,
        params.principalId,
        params.tenantId,
        "knowledge",
        "find",
        grants.conditionRegistry,
      );
      if (decision.effect !== "allow") {
        const effect = decision.effect ?? "no-matching-grant";
        log.info(
          `ask: denied knowledge:find for ${params.principalId} (effect=${effect})`,
          {
            principalId: params.principalId,
            effect,
          },
        );
        throw new KnowledgeNotPermittedError();
      }
      if (!options.generate) {
        throw new KnowledgeError(
          501,
          "ask() requires a `generate` function. Pass one to " +
            "createKnowledgePlane/mountKnowledgeEngine, wired to your " +
            "inference layer.",
        );
      }
      const findResult = await plane.find({
        tenantId: params.tenantId,
        principalId: params.principalId,
        query: params.query,
        includeEvidence: true,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.sources !== undefined ? { sources: params.sources } : {}),
      });
      const mem = await recallForAsk({
        memory: options.memory,
        includeMemory: params.includeMemory,
        tenantId: params.tenantId,
        principalId: params.principalId,
        query: params.query,
      });
      const answer = await synthesizeAnswer(
        params.query,
        {
          hits: findItemsToHits(findResult.items),
          evidence: findResult.evidence ?? "none",
        },
        options.generate,
        mem.texts,
      );
      const degraded: DegradeFlag[] = [
        ...(findResult.degraded ?? []),
        ...mem.degraded,
      ];
      return {
        ...answer,
        ...(degraded.length > 0 ? { degraded } : {}),
      };
    },

    async add(params) {
      const hasContent = params.content !== undefined;
      const hasFile = params.file !== undefined;
      if (hasContent === hasFile) {
        throw new KnowledgeError(
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
          throw new KnowledgeError(
            400,
            "file requires a textExtractor on the knowledge plane",
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

      const { visibility, blockPrincipalIds } =
        resolveShareAndVisibility(params);

      return store.add({
        tenantId: params.tenantId,
        principalId: params.principalId,
        title,
        text,
        visibility,
        ...(blockPrincipalIds !== undefined ? { blockPrincipalIds } : {}),
        ...(params.attributes !== undefined
          ? { attributes: params.attributes }
          : {}),
        ...(params.externalRef !== undefined
          ? { externalRef: params.externalRef }
          : {}),
      });
    },

    async recent(params) {
      const limit = resolveRecentLimit(params.limit);
      return store.recent({
        tenantId: params.tenantId,
        principalId: params.principalId,
        ...(limit !== undefined ? { limit } : {}),
      });
    },

    remember: memoryApi.remember,
    recall: memoryApi.recall,

    async close() {
      await store.close();
    },
  };

  return plane;
}

/**
 * Default plane: engine pgvector store + hybrid search.
 */
function createPlaneFromEngine(
  config: KnowledgeConfig,
  grants: GrantConfig | undefined,
  options: KnowledgePlaneOptions,
): KnowledgePlane {
  const memoryApi = makeRememberRecall(options);

  // Catch a chunk-size / reranker-limit mismatch at construction time, rather
  // than silently on every find once the reranker starts rejecting batches.
  // Throws instead of warning: a mismatch means every rerank call for this
  // host WILL 413 and silently degrade to fused ranking, with no per-request
  // signal — a construction-time failure surfaces that once, loudly.
  // Safe to throw because the per-model default budget
  // (`defaultMaxDocCharsForModel`) is self-consistent by construction —
  // validation can only fire on an operator's own `maxDocChars` override,
  // never spuriously on an unmodified config.
  // Lives here (not only in mountKnowledgeEngine) so standalone construction
  // cannot silently degrade on a bad override.
  const rerankConfig = toRerankClientConfig(config.knowledge.rerank);
  if (rerankConfig) validateRerankConfig(rerankConfig);

  // Resolve once here so EngineConfig.ftsLanguage is concrete for every
  // service — loadKnowledgeConfig already runs parseFtsLanguage, but a
  // hand-built EngineConfig may still carry an empty/absent value; this is
  // the single defaulting site services rely on.
  const engineConfig: EngineConfig = {
    ...config.knowledge,
    ftsLanguage: parseFtsLanguage(config.knowledge.ftsLanguage),
  };
  const { db, sql }: { db: Db; sql: RawSql } = createDb(engineConfig);
  const deps = { db, sql, config: engineConfig };

  // Serving-path schema validation, industry-standard fail-fast shape
  // (Hibernate validate / Rails check_all_pending!): the mount is
  // synchronous, so "before accepting traffic" becomes a memoized check
  // awaited by the first query. Read-only; migration stays a deploy step.
  // NOTE this is a lazy check, not a boot-time one: nothing forces it to run
  // until the first real find()/add() call, so a host that neither
  // runs runKnowledgeMigrations itself nor wires a readiness probe will not
  // learn about a language mismatch until that first call fails. A host
  // that wants a real boot-time guarantee MUST call the exported
  // verifyFtsLanguage from its own readiness probe — this memo then
  // resolves instantly against the already-verified schema.
  const ensureVerified = createFtsVerification(
    createRawSqlClient(sql),
    engineConfig.ftsLanguage,
  );

  /**
   * Hybrid retrieval + block-list post-filter. Shared by find() and ask().
   * Returns the full HybridSearchResult so ask can synthesize from hits.
   */
  async function retrieve(params: {
    tenantId: string;
    principalId: string;
    query: string;
    k?: number;
    kinds?: string[];
    entityIds?: string[];
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
      });

      // Block-list post-filter: docs may store acl_block as a list of
      // principal ids. Engine visibility does not model block lists yet.
      // Shared with recent via readBlockList / blockedDocumentIds.
      if (result.hits.length === 0) return result;
      const docIds = Array.from(
        new Set(result.hits.map((h) => h.document_id)),
      );
      const rows = await sql<
        { id: string; attributes: Record<string, unknown> | null }[]
      >`
          SELECT id, attributes
          FROM "knowledge"."document"
          WHERE id = ANY(${docIds}::text[])
        `;
      const { blocked, unreadable } = blockedDocumentIds(
        docIds,
        rows,
        params.principalId,
      );
      if (unreadable.length > 0) {
        // Cap the sample so a large withhold batch cannot flood logs; count
        // is always present so the full size is still auditable.
        const sampleLimit = 20;
        const documentIds = unreadable.slice(0, sampleLimit);
        const more =
          unreadable.length > sampleLimit
            ? ` (+${unreadable.length - sampleLimit} more)`
            : "";
        log.warn(
          `find: ${unreadable.length} document(s) had an unreadable acl_block or missing row; withholding: ${documentIds.join(", ")}${more}`,
          { count: unreadable.length, documentIds },
        );
      }
      if (blocked.size === 0) return result;
      const hits = result.hits.filter((h) => !blocked.has(h.document_id));
      // result.evidence is already "none" only when there were no hits, so
      // a post-filter that empties the list is the only way to reach "none".
      return {
        ...result,
        hits,
        evidence: hits.length === 0 ? "none" : result.evidence,
      };
    } catch (err) {
      if (err instanceof KnowledgeSearchInputError) {
        throw new KnowledgeError(400, err.message);
      }
      throw err;
    }
  }

  const plane: KnowledgePlane = {
    async find(params) {
      const limit = resolveFindLimit(params.limit);
      let localItems: FindItem[] = [];
      let localDegraded: DegradeFlag[] | undefined;
      let localEvidence: HybridSearchResult["evidence"] | undefined;

      if (wantsLocalChannel(params.sources)) {
        const result = await retrieve({
          tenantId: params.tenantId,
          principalId: params.principalId,
          query: params.query,
          ...(limit !== undefined ? { k: limit } : {}),
          ...(params.kinds !== undefined ? { kinds: params.kinds } : {}),
          ...(params.entityIds !== undefined
            ? { entityIds: params.entityIds }
            : {}),
        });
        localItems = hitsToFindItems(result.hits);
        localDegraded = result.degraded;
        localEvidence = result.evidence;
      }

      const live = await collectLiveItems({
        sources: options.sources,
        query: params.query,
        tenantId: params.tenantId,
        principalId: params.principalId,
        limit,
        filter: params.sources,
      });

      // No live channel activity → preserve hybrid evidence semantics.
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

      return mergeToFindResult({
        localItems,
        ...(localDegraded !== undefined ? { localDegraded } : {}),
        liveItems: live.items,
        liveDegraded: live.degraded,
        limit,
        ...(params.sources !== undefined ? { sources: params.sources } : {}),
        ...(params.includeEvidence !== undefined
          ? { includeEvidence: params.includeEvidence }
          : {}),
      });
    },

    async ask(params) {
      // Capability layer. Callers reaching the plane in-process bypass the
      // HTTP surface's `requireGrant("knowledge", ...)` route guard, so the
      // check has to live here — AUTH.md is explicit that the capability and
      // data layers are independent and BOTH must allow. Per-document
      // visibility (enforced inside `find`) is not a substitute for "may
      // this principal search at all".
      // Same action as HTTP find/ask/recent: knowledge:find.
      if (!grants) {
        throw new KnowledgeError(
          501,
          "ask() requires a GrantConfig. Pass grants to " +
            "createKnowledgePlane/mountKnowledgeEngine.",
        );
      }
      const decision = await authorize(
        grants.grantStore,
        params.principalId,
        params.tenantId,
        "knowledge",
        "find",
        grants.conditionRegistry,
      );
      // `effect: null` means no grant matched at all — deny by default, same
      // as an explicit deny. Only an explicit allow proceeds.
      if (decision.effect !== "allow") {
        // Interpolate into the message string: some sinks only render the
        // template, not the structured context object (see src/log.ts).
        const effect = decision.effect ?? "no-matching-grant";
        log.info(
          `ask: denied knowledge:find for ${params.principalId} (effect=${effect})`,
          {
            principalId: params.principalId,
            effect,
          },
        );
        throw new KnowledgeNotPermittedError();
      }

      // Fail closed on missing generate *before* retrieval so a misconfigured
      // host gets the promised 501 instead of paying for hybrid search (or
      // surfacing a DB error that masks the real problem).
      if (!options.generate) {
        throw new KnowledgeError(
          501,
          "ask() requires a `generate` function. Pass one to " +
            "createKnowledgePlane/mountKnowledgeEngine, wired to your " +
            "inference layer.",
        );
      }

      // Find AS the asking principal — the per-document ACL boundary,
      // including the block-list post-filter. includeEvidence so synthesis
      // can report evidence; goes through plane.find so tests can stub it.
      const findResult = await plane.find({
        tenantId: params.tenantId,
        principalId: params.principalId,
        query: params.query,
        includeEvidence: true,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.sources !== undefined ? { sources: params.sources } : {}),
      });

      const mem = await recallForAsk({
        memory: options.memory,
        includeMemory: params.includeMemory,
        tenantId: params.tenantId,
        principalId: params.principalId,
        query: params.query,
      });

      const answer = await synthesizeAnswer(
        params.query,
        {
          hits: findItemsToHits(findResult.items),
          evidence: findResult.evidence ?? "none",
        },
        options.generate,
        mem.texts,
      );
      const degraded: DegradeFlag[] = [
        ...(findResult.degraded ?? []),
        ...mem.degraded,
      ];
      return {
        ...answer,
        ...(degraded.length > 0 ? { degraded } : {}),
      };
    },

    async add(params) {
      await ensureVerified();

      const hasContent = params.content !== undefined;
      const hasFile = params.file !== undefined;
      if (hasContent === hasFile) {
        throw new KnowledgeError(
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
          throw new KnowledgeError(
            400,
            "file requires a textExtractor on the knowledge plane",
          );
        }
        const extracted = await options.textExtractor.extract({
          bytes: file.bytes,
          ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
          ...(file.filename !== undefined ? { filename: file.filename } : {}),
        });
        text = extracted.text;
        title =
          file.title ??
          extracted.title ??
          file.filename ??
          "untitled";
      }

      const { visibility, blockPrincipalIds } =
        resolveShareAndVisibility(params);

      const adapter = params.adapter ?? "mcp";
      const externalRef =
        params.externalRef ??
        `knowledge:${params.tenantId}:${crypto.randomUUID()}`;
      const attributes: Record<string, string | number | boolean | null> = {
        ...(params.attributes ?? {}),
      };
      if (blockPrincipalIds && blockPrincipalIds.length > 0) {
        attributes["acl_block"] = JSON.stringify(blockPrincipalIds);
      }

      const captureResult = await captureDocument(deps, {
        tenantId: params.tenantId,
        adapter,
        occurredAt: new Date().toISOString(),
        document: {
          kind: params.kind ?? "note",
          title,
          externalRef,
          visibility,
          entityHints: [],
          chunks: [{ ordinal: 0, text }],
          actor: { kind: "human", principalId: params.principalId },
          contentHash: "", // recomputed canonically in adapt-and-plan
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        },
      });
      // Both captured and noop return documentId — always surface it.
      return { documentId: captureResult.documentId };
    },

    async recent(params) {
      const limit = resolveRecentLimit(params.limit);
      return listTimelineEvents({
        db,
        tenantId: params.tenantId,
        principalId: params.principalId,
        ...(limit !== undefined ? { limit } : {}),
      });
    },

    remember: memoryApi.remember,
    recall: memoryApi.recall,

    async close() {
      await sql.end({ timeout: 5 });
    },
  };

  return plane;
}
