/**
 * Knowledge plane backed by the engine's pgvector Postgres. Wraps the capture
 * and hybrid-search services directly — no HTTP hop.
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
} from "./services/search.ts";
import {
  listTimelineEvents,
  type TimelineEvent,
} from "./services/timeline.ts";
import type { KnowledgeConfig } from "./mount-config.ts";
import type { GrantConfig } from "./routes/deps.ts";

// Re-export so hosts typing plane.search() results don't reach into services/.
export type { HybridSearchResult } from "./services/search.ts";
export type { SearchHit } from "./core/schemas/search.ts";
export type { VisibilitySpec } from "./core/schemas/document.ts";

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

export type KnowledgeIdentity = {
  principalId: string;
  tenantId: string;
};

export type KnowledgeSearchParams = KnowledgeIdentity & {
  query: string;
  k?: number;
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
};

export type KnowledgeAskParams = KnowledgeIdentity & {
  query: string;
  k?: number;
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
};

/** Thrown when the asking principal lacks the knowledge:search capability. */
export class KnowledgeNotPermittedError extends Error {
  constructor() {
    super("principal lacks the knowledge:search grant");
    this.name = "KnowledgeNotPermittedError";
  }
}

export type KnowledgeCaptureParams = KnowledgeIdentity & {
  title: string;
  text: string;
  kind?: string;
  adapter?: string;
  externalRef?: string;
  visibility?: VisibilitySpec;
  /** Principal ids blocked from seeing this doc (stored for read-path post-filter). */
  blockPrincipalIds?: string[];
  attributes?: Record<string, string | number | boolean | null>;
};

export type KnowledgeTimelineParams = KnowledgeIdentity & {
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
  search(params: KnowledgeSearchParams): Promise<HybridSearchResult>;
  ask(params: KnowledgeAskParams): Promise<AskResult>;
  capture(params: KnowledgeCaptureParams): Promise<void>;
  timeline(params: KnowledgeTimelineParams): Promise<TimelineEvent[]>;
  close(): Promise<void>;
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
 */
export async function synthesizeAnswer(
  query: string,
  result: Pick<HybridSearchResult, "hits" | "evidence">,
  generate: Generate,
): Promise<AskResult> {
  if (result.hits.length === 0) {
    return {
      text: "I couldn't find anything you have access to that answers that.",
      citations: [],
      evidence: "none",
    };
  }

  const { block, citations } = buildContext(result.hits);
  if (!block) {
    return {
      text: "I found matching documents but couldn't read any text out of them.",
      citations: [],
      evidence: "none",
    };
  }

  const text = await generate([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Question: ${query}\n\nContext:\n${block}` },
  ]);

  return { text, citations, evidence: result.evidence };
}

export type KnowledgePlaneOptions = {
  /** Required for `ask()`; omit if the host only captures and searches. */
  generate?: Generate;
};

/**
 * Build a knowledge plane.
 *
 * - `grants` is required for `ask()` (in-process capability check). Standalone
 *   capture/search callers may omit it — same as #8's out-of-band plane.
 * - Rerank config is validated at construction (same as mount).
 */
export function createKnowledgePlane(
  config: KnowledgeConfig,
  grants?: GrantConfig,
  options: KnowledgePlaneOptions = {},
): KnowledgePlane {
  // Catch a chunk-size / reranker-limit mismatch at construction time, rather
  // than silently on every search once the reranker starts rejecting batches.
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
  // until the first real search()/capture() call, so a host that neither
  // runs runKnowledgeMigrations itself nor wires a readiness probe will not
  // learn about a language mismatch until that first call fails. A host
  // that wants a real boot-time guarantee MUST call the exported
  // verifyFtsLanguage from its own readiness probe — this memo then
  // resolves instantly against the already-verified schema.
  const ensureVerified = createFtsVerification(
    createRawSqlClient(sql),
    engineConfig.ftsLanguage,
  );

  const plane: KnowledgePlane = {
    async search(params) {
      try {
        await ensureVerified();
        const result = await hybridSearch(deps, {
          tenantId: params.tenantId,
          principalId: params.principalId,
          query: params.query,
          k: params.k,
          kinds: params.kinds,
          entityIds: params.entityIds,
        });

        // Block-list post-filter: docs may store acl_block as a list of
        // principal ids. Engine visibility does not model block lists yet.
        // Shared with timeline via readBlockList / blockedDocumentIds.
        if (result.hits.length === 0) return result;
        const docIds = Array.from(
          new Set(result.hits.map((h) => h.document_id)),
        );
        const rows = await sql<
          { id: string; attributes: Record<string, unknown> | null }[]
        >`
          SELECT id, attributes
          FROM knowledge_document
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
            `search: ${unreadable.length} document(s) had an unreadable acl_block or missing row; withholding: ${documentIds.join(", ")}${more}`,
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
    },

    async ask(params) {
      // Capability layer. Callers reaching the plane in-process bypass the
      // HTTP surface's `requireGrant("knowledge", ...)` route guard, so the
      // check has to live here — AUTH.md is explicit that the capability and
      // data layers are independent and BOTH must allow. Per-document
      // visibility (enforced inside `search`) is not a substitute for "may
      // this principal search at all".
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
        "search",
        grants.conditionRegistry,
      );
      // `effect: null` means no grant matched at all — deny by default, same
      // as an explicit deny. Only an explicit allow proceeds.
      if (decision.effect !== "allow") {
        // Interpolate into the message string: some sinks only render the
        // template, not the structured context object (see src/log.ts).
        const effect = decision.effect ?? "no-matching-grant";
        log.info(
          `ask: denied knowledge:search for ${params.principalId} (effect=${effect})`,
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

      // Search AS the asking principal — the per-document ACL boundary,
      // including the block-list post-filter above.
      const result = await plane.search({
        tenantId: params.tenantId,
        principalId: params.principalId,
        query: params.query,
        ...(params.k !== undefined ? { k: params.k } : {}),
      });

      return synthesizeAnswer(params.query, result, options.generate);
    },

    async capture(params) {
      await ensureVerified();
      const adapter = params.adapter ?? "mcp";
      const externalRef =
        params.externalRef ??
        `knowledge:${params.tenantId}:${crypto.randomUUID()}`;
      const visibility = params.visibility ?? { mode: "tenant" as const };
      const attributes: Record<string, string | number | boolean | null> = {
        ...(params.attributes ?? {}),
      };
      if (params.blockPrincipalIds && params.blockPrincipalIds.length > 0) {
        attributes["acl_block"] = JSON.stringify(params.blockPrincipalIds);
      }

      await captureDocument(deps, {
        tenantId: params.tenantId,
        adapter,
        occurredAt: new Date().toISOString(),
        document: {
          kind: params.kind ?? "note",
          title: params.title,
          externalRef,
          visibility,
          entityHints: [],
          chunks: [{ ordinal: 0, text: params.text }],
          actor: { kind: "human", principalId: params.principalId },
          contentHash: "", // recomputed canonically in adapt-and-plan
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        },
      });
    },

    async timeline(params) {
      return listTimelineEvents({
        db,
        tenantId: params.tenantId,
        principalId: params.principalId,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };

  return plane;
}
