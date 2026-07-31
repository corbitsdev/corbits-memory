import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db, RawSql } from "../db/client.ts";
import type { EngineConfig } from "../config.ts";
import { LIVE_GENERATION } from "../core/generation.ts";
import {
  knowledgeChunk,
  knowledgeDocument,
  knowledgeEdge,
  knowledgeVersion,
} from "../db/schema.ts";
import { createRawSqlClient } from "../core/embed-sql.ts";
import {
  cosineDistanceExpr,
  EMBED_TABLE_NAME_PATTERN,
  resolveActiveEmbedTable,
} from "../core/embed-model-registry.ts";
import { embedTexts, type EmbedClientConfig } from "../core/embed-client.ts";
import {
  rerankDocuments,
  RerankConfigError,
  RerankQueryTooLongError,
  validateRerankConfig,
  type RerankClientConfig,
} from "../core/rerank-client.ts";
import { mmrRerank, type MmrItem } from "../core/mmr.ts";
import { recordDegrade } from "../core/degrade-metrics.ts";
import {
  authorityBoostMultiplier,
  clampOverfetchMultiplier,
  DEFAULT_OVERFETCH_MULTIPLIER,
  fuseRrf,
  normalizeScoresToUnit,
  recencyBoostMultiplier,
  RECENCY_HALF_LIFE_MS,
  toRankedCandidates,
  type DegradeFlag,
} from "../core/hybrid-search.ts";
import { formatCaughtError, log } from "../log.ts";
import { resolveGenerationSearchParams } from "./transform.ts";
import type {
  SearchChannel,
  SearchHit,
  SearchResponse,
} from "../core/schemas/search.ts";

// The single doorway every retrieval read passes through. Every query below
// filters `tenant_id` first, unconditionally, before any visibility logic
// runs — tenant isolation is absolute.

export const MAX_K = 100;
export const DEFAULT_HYBRID_TOP_K = 8;

// Mirrors the source's MAX_CANDIDATES — a hard ceiling on the per-channel
// overfetch regardless of how large `k` is asked for.
const MAX_CANDIDATES_PER_CHANNEL = 500;

// Pipeline stage sizes, applied only on the reranked path: overfetch the
// RRF-fused, per-document-deduped candidates down to top-50 before sending
// them to the cross-encoder (bounds rerank request cost), then narrow the
// boosted result to top-15-20 before the MMR diversity pass (bounds the
// O(n^2) greedy MMR cost), then MMR picks the final `k`.
const RERANK_CANDIDATE_LIMIT = 50;
const MMR_POOL_SIZE = 20;
const MMR_LAMBDA = 0.7;

// Evidence thresholds — a documented, tunable default, not a final answer:
// - zero hits => 'none'
// - top-ranked hit's ts_rank >= STRONG_RANK_FLOOR => 'strong'
// - otherwise (hits exist but the top rank is weak) => 'weak'
const STRONG_RANK_FLOOR = 0.05;

// Authority as a rank prior AND an evidence cap.
// Ranking: final_score = relevance_score * (1 + AUTHORITY_WEIGHT * authority).
export const AUTHORITY_WEIGHT = 0.5;

export function authorityWeightedScore(
  relevanceScore: number,
  authority: number,
  authorityWeight: number = AUTHORITY_WEIGHT,
): number {
  return relevanceScore * (1 + authorityWeight * authority);
}

// Evidence cap: a hit only reaches 'strong' when BOTH its raw lexical
// relevance clears STRONG_RANK_FLOOR AND its authority clears this floor.
const AUTHORITY_STRONG_FLOOR = 0.3;

// Second, reranked-path-only strong floor. `deriveHybridEvidence`'s lexical
// ts_rank check under-reports a query resolved mostly through the DENSE
// channel: a semantic paraphrase with little literal keyword overlap can be
// a highly confident cross-encoder match yet always score "weak" on
// ts_rank alone. When reranking ran, the top hit's RAW cross-encoder score
// (the reranker's own [0,1] relevance, before RRF normalization and the
// authority/recency boosts — NOT the boosted finalScore, whose batch top is
// always ~1 and would make this floor meaningless) clearing THIS floor,
// combined with authority clearing AUTHORITY_STRONG_FLOOR, is an independent,
// equally valid "strong" signal alongside the lexical one.
const RERANK_STRONG_FLOOR = 0.6;

export class KnowledgeSearchInputError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeSearchInputError";
  }
}

export interface CandidateRow {
  chunkId: string;
  documentId: string;
  versionId: string;
  version: number;
  status: SearchHit["status"];
  title: string;
  kind: string;
  adapter: string;
  externalRef: string;
  createdByKind: SearchHit["created_by_kind"];
  generatorAgentId: string | null;
  snippetText: string;
  rank: number;
  occurredAt: Date;
  // The version's stored 0..1 authority score (computed at capture time;
  // never recomputed here).
  authority: number;
}

export function snippet(text: string, maxLen = 240): string {
  const trimmed = text.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

// The single visibility predicate every retrieval channel (lexical, and the
// dense channel) must apply. `principalId === null` means the caller has no
// principal identity to check — only tenant-wide-visible documents match; a
// document scoped to `principals`/`private` never matches a null principal.
//
// IMPORTANT: a null principal must NOT be modeled as "matches an empty
// principal_ids array" — jsonb `@>` containment treats the empty array as a
// subset of EVERY array, so `principal_ids @> '[]'::jsonb` is TRUE
// regardless of what's actually in principal_ids, which would let a
// null-principal caller see every `principals`/`private` document (a real
// ACL bypass this predicate previously had). A null principal instead gets
// its own, structurally simpler predicate: tenant-wide-visible documents
// ONLY, with no principal_ids check at all.
export function visibilityPredicateSql(principalId: string | null) {
  if (principalId === null) {
    return sql`(${knowledgeDocument.visibilityMode} = 'tenant')`;
  }
  return sql`(
    ${knowledgeDocument.visibilityMode} = 'tenant'
    OR (
      ${knowledgeDocument.visibilityMode} IN ('principals', 'private')
      AND ${knowledgeDocument.visibilityPrincipalIds} @> ${JSON.stringify([principalId])}::jsonb
    )
  )`;
}

// The raw (per-chunk, non-deduped) SQL fragment text mirroring
// `visibilityPredicateSql` above, for the dense channel which queries a
// dynamically-named `knowledge_embedding_<key>` table through the raw
// postgres-js pool (no drizzle schema exists for that table, so the drizzle
// `sql` fragment above cannot be reused verbatim there). Any change to the
// visibility rule must be applied to BOTH this string and
// `visibilityPredicateSql` — there is no third implementation anywhere else.
export const VISIBILITY_PREDICATE_RAW_SQL = `(
  kd.visibility_mode = 'tenant'
  OR (
    kd.visibility_mode IN ('principals', 'private')
    AND kd.visibility_principal_ids @> $VISIBILITY_PRINCIPAL_JSON::jsonb
  )
)`;

// The null-principal counterpart to `VISIBILITY_PREDICATE_RAW_SQL`, mirroring
// `visibilityPredicateSql(null)`'s tenant-only fragment — no principal_ids
// check, no `$VISIBILITY_PRINCIPAL_JSON` placeholder to substitute.
export const VISIBILITY_PREDICATE_RAW_SQL_NULL_PRINCIPAL = `(kd.visibility_mode = 'tenant')`;

// The single call site (fetchDenseCandidates) selects between the two raw
// fragments above by whether a principal is present — never re-derive this
// choice, and never let the two fragments' non-null shape drift from
// `visibilityPredicateSql`'s non-null branch.
export function visibilityPredicateRawSql(hasPrincipal: boolean): string {
  return hasPrincipal
    ? VISIBILITY_PREDICATE_RAW_SQL
    : VISIBILITY_PREDICATE_RAW_SQL_NULL_PRINCIPAL;
}

const ADAPTER_OPEN_TYPES: Record<string, string> = {
  artifact: "artifact",
  task: "task",
  workflow_run: "workflow_run",
  mail: "mail",
};

// The routable open target: source row via the external_ref suffix when the
// adapter maps to a deep-linkable kind; generic knowledge doc otherwise.
function openTarget(
  adapter: string,
  externalRef: string,
  documentId: string,
): { type: string; id: string } {
  const openType = ADAPTER_OPEN_TYPES[adapter];
  const prefix = `${adapter}:`;
  if (openType && externalRef.startsWith(prefix)) {
    return { type: openType, id: externalRef.slice(prefix.length) };
  }
  return { type: "knowledge", id: documentId };
}

export function toHit(
  row: CandidateRow,
  channelsMatched: SearchHit["channels_matched"] = ["lexical"],
  // The reranked path computes its own final score (normalized rerank score
  // * bounded authority/recency boosts) and passes it here instead of
  // re-deriving `authorityWeightedScore`, which would double-apply
  // authority. Absent (the non-reranked/degraded path), behavior falls back
  // to the authority-weighted score.
  scoreOverride?: number,
  // The configured authority weight for the generation being searched
  // (defaults to the module constant for 'live') — used only for the
  // fallback score above, since a scoreOverride already has its own
  // authority handling baked in (the reranked path's boosted score).
  authorityWeight: number = AUTHORITY_WEIGHT,
): SearchHit {
  return {
    chunk_id: row.chunkId,
    document_id: row.documentId,
    version: row.version,
    version_id: row.versionId,
    status: row.status,
    score:
      scoreOverride ??
      authorityWeightedScore(row.rank, row.authority, authorityWeight),
    title: row.title,
    snippet: snippet(row.snippetText),
    kind: row.kind,
    created_by_kind: row.createdByKind,
    ...(row.generatorAgentId
      ? { generator_agent_id: row.generatorAgentId }
      : {}),
    citation: {
      adapter: row.adapter,
      external_ref: row.externalRef,
      open: openTarget(row.adapter, row.externalRef, row.documentId),
    },
    entity_ids: [],
    channels_matched: channelsMatched,
  };
}

// Evidence is capped by authority, not just relevance: the top-ranked hit
// (by raw relevance) must ALSO clear AUTHORITY_STRONG_FLOOR to report
// 'strong'. A relevant hit backed only by a low-authority source reports
// 'weak' instead of overstating confidence.
export function deriveEvidence(
  hits: readonly CandidateRow[],
): SearchResponse["evidence"] {
  if (hits.length === 0) return "none";
  const top = hits.reduce((best, h) => (h.rank > best.rank ? h : best));
  if (top.rank < STRONG_RANK_FLOOR) return "weak";
  return top.authority >= AUTHORITY_STRONG_FLOOR ? "strong" : "weak";
}

// Evidence is primarily derived from the LEXICAL channel, using the same
// ts_rank threshold `deriveEvidence` already applies — that threshold was
// calibrated against ts_rank's scale, and an RRF-fused score lives on an
// entirely different, much smaller scale, so reusing the threshold directly
// against fused scores would make "strong" unreachable via that path. A
// SECOND, independent "strong" path exists for the reranked path: when
// `rerankedTop` is supplied (reranking ran and produced a top hit), a rerank
// score clearing RERANK_STRONG_FLOOR combined with authority clearing
// AUTHORITY_STRONG_FLOOR is strong evidence on its own, even when the
// lexical channel barely (or never) matched — this is what lets a query
// resolved mostly through the DENSE channel report "strong" instead of
// always "weak". A result that came back only through the dense channel,
// on the non-reranked/degraded path (no `rerankedTop`), is still "weak".
export function deriveHybridEvidence(
  lexicalRows: readonly CandidateRow[],
  finalHitCount: number,
  rerankedTop?: { rerankScore: number; authority: number },
): SearchResponse["evidence"] {
  if (finalHitCount === 0) return "none";
  if (
    rerankedTop &&
    rerankedTop.rerankScore >= RERANK_STRONG_FLOOR &&
    rerankedTop.authority >= AUTHORITY_STRONG_FLOOR
  ) {
    return "strong";
  }
  if (lexicalRows.length === 0) return "weak";
  return deriveEvidence(lexicalRows);
}

// Collapses overfetched per-chunk candidates to the single highest-ranked
// chunk per document, sorted by the authority-weighted score desc then
// recency desc. Called AFTER RRF fusion has re-ranked chunks across
// channels — the single dedupe implementation, and the single place
// authority is applied as a rank prior.
export function dedupeCandidatesPerDocument(
  rows: readonly CandidateRow[],
  // `false` on the reranked path: authority moves to that pipeline's
  // post-rerank bounded-boost stage, so the per-document pick/sort here
  // must rank on raw fused score alone, or authority would apply twice.
  applyAuthorityPrior = true,
  authorityWeight: number = AUTHORITY_WEIGHT,
): CandidateRow[] {
  const scoreOf = (row: CandidateRow): number =>
    applyAuthorityPrior
      ? authorityWeightedScore(row.rank, row.authority, authorityWeight)
      : row.rank;

  const byDocument = new Map<string, CandidateRow>();
  for (const row of rows) {
    const existing = byDocument.get(row.documentId);
    if (!existing || scoreOf(row) > scoreOf(existing)) {
      byDocument.set(row.documentId, row);
    }
  }
  return [...byDocument.values()].sort(
    (a, b) =>
      scoreOf(b) - scoreOf(a) ||
      b.occurredAt.getTime() - a.occurredAt.getTime(),
  );
}

export async function attachEntityIds(
  db: Db,
  tenantId: string,
  rows: CandidateRow[],
): Promise<Map<string, string[]>> {
  const documentIds = [...new Set(rows.map((r) => r.documentId))];
  if (documentIds.length === 0) return new Map();
  const edges = await db
    .select({
      documentId: knowledgeEdge.fromRef,
      entityId: knowledgeEdge.toRef,
    })
    .from(knowledgeEdge)
    .where(
      and(
        eq(knowledgeEdge.tenantId, tenantId),
        eq(knowledgeEdge.fromType, "document"),
        eq(knowledgeEdge.toType, "entity"),
        inArray(knowledgeEdge.fromRef, documentIds),
      ),
    );
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const list = map.get(edge.documentId) ?? [];
    list.push(edge.entityId);
    map.set(edge.documentId, list);
  }
  return map;
}

interface LexicalCandidateParams {
  db: Db;
  tenantId: string;
  principalId: string | null;
  query: string;
  ftsLanguage: string;
  overfetchLimit: number;
  kinds?: string[] | undefined;
  entityIds?: string[] | undefined;
  // Defaults to 'live' — every version-scoped query filters by generation so
  // a replayed generation's chunks never leak into a live search and vice
  // versa (the replay pipeline).
  generation?: string | undefined;
}

// The single FTS-candidate query for the lexical channel. Returns raw,
// overfetched, non-deduped per-chunk rows already filtered by tenant + ACL +
// status — the caller decides how to combine/dedupe/truncate them.
export async function fetchLexicalCandidates(
  params: LexicalCandidateParams,
): Promise<CandidateRow[]> {
  const {
    db,
    tenantId,
    principalId,
    query,
    ftsLanguage,
    overfetchLimit,
    kinds,
    entityIds,
    generation = LIVE_GENERATION,
  } = params;

  const conditions = [
    eq(knowledgeChunk.tenantId, tenantId),
    eq(knowledgeVersion.status, "active"),
    eq(knowledgeVersion.generation, generation),
    visibilityPredicateSql(principalId),
  ];

  if (kinds && kinds.length > 0) {
    conditions.push(inArray(knowledgeDocument.kind, kinds));
  }

  let rankExpr = sql<number>`0::double precision`;
  if (query !== "") {
    // Bound as a parameter and cast to regconfig — never spliced — and
    // required to match the language the generated column was built with
    // (verified against the catalog by runKnowledgeMigrations).
    rankExpr = sql<number>`ts_rank("knowledge_chunk"."text_fts", plainto_tsquery(${ftsLanguage}::regconfig, ${query}))`;
    conditions.push(
      sql`"knowledge_chunk"."text_fts" @@ plainto_tsquery(${ftsLanguage}::regconfig, ${query})`,
    );
  }

  if (entityIds && entityIds.length > 0) {
    const matchingDocIds = db
      .select({ documentId: knowledgeEdge.fromRef })
      .from(knowledgeEdge)
      .where(
        and(
          eq(knowledgeEdge.tenantId, tenantId),
          eq(knowledgeEdge.fromType, "document"),
          eq(knowledgeEdge.toType, "entity"),
          inArray(knowledgeEdge.toRef, entityIds),
        ),
      );
    conditions.push(inArray(knowledgeDocument.id, matchingDocIds));
  }

  const rows = await db
    .select({
      chunkId: knowledgeChunk.id,
      documentId: knowledgeChunk.documentId,
      versionId: knowledgeChunk.versionId,
      version: knowledgeVersion.version,
      status: knowledgeVersion.status,
      title: knowledgeDocument.title,
      kind: knowledgeDocument.kind,
      adapter: knowledgeDocument.adapter,
      externalRef: knowledgeDocument.externalRef,
      createdByKind: knowledgeVersion.createdByKind,
      generatorAgentId: knowledgeVersion.generatorAgentId,
      snippetText: knowledgeChunk.text,
      rank: rankExpr,
      occurredAt: knowledgeVersion.occurredAt,
      authority: knowledgeVersion.authority,
    })
    .from(knowledgeChunk)
    .innerJoin(
      knowledgeVersion,
      eq(knowledgeChunk.versionId, knowledgeVersion.id),
    )
    .innerJoin(
      knowledgeDocument,
      eq(knowledgeChunk.documentId, knowledgeDocument.id),
    )
    .where(and(...conditions))
    .orderBy(desc(rankExpr), desc(knowledgeVersion.occurredAt))
    .limit(overfetchLimit);

  return rows as CandidateRow[];
}

interface FetchDenseCandidatesArgs {
  sql: RawSql;
  embedClientConfig: EmbedClientConfig;
  fetchImpl: typeof fetch;
  tenantId: string;
  principalId: string | null;
  query: string;
  overfetchLimit: number;
  // Defaults to 'live' — see fetchLexicalCandidates' generation note. NOTE:
  // this filters the chunk/version join, not which per-model embedding
  // TABLE is queried — resolveActiveEmbedTable picks the tenant's single
  // most-recently-activated model regardless of generation, so a replay run
  // that activates a DIFFERENT embed model than the live one currently uses
  // becomes the tenant's active table for every generation's dense channel,
  // including live's. Scoping activation itself per-generation is out of
  // the replay pipeline's scope; callers should reuse the live embed model in a
  // transform_config unless they intend that tradeoff.
  generation?: string | undefined;
}

// Whether this pool's pgvector understands hnsw.iterative_scan, learned
// from the first dense query rather than re-probed on every call.
const iterativeScanSupport = new WeakMap<RawSql, boolean>();

/**
 * The hnsw.ef_search value for a dense query: the overfetch limit clamped
 * into [40, 1000]. pgvector accepts 1..1000 (default 40); flooring at 40 is
 * a product choice so we never run worse than the GUC default, and 1000 is
 * the GUC hard max. Non-finite input falls back to the default.
 */
export function hnswEfSearch(overfetchLimit: number): number {
  const limit = Number.isFinite(overfetchLimit) ? Math.floor(overfetchLimit) : 40;
  return Math.max(40, Math.min(1000, limit));
}

// Dense channel: embeds the query, then runs an ANN cosine-distance query
// against the tenant's ACTIVE embedding table only (never a superseded or
// inactive model's table), joined back to knowledge_chunk/version/document
// with the EXACT SAME visibility predicate as the lexical channel
// (VISIBILITY_PREDICATE_RAW_SQL) — there is no second ACL implementation.
// Returns `null` (not an error) when there is no active embed model
// configured for the tenant yet, or when the query is empty — both are
// legitimate "dense not applicable" states, distinct from a runtime
// failure, but the caller treats both the same way for the `degraded` flag.
export async function fetchDenseCandidates(
  args: FetchDenseCandidatesArgs,
): Promise<CandidateRow[] | null> {
  const {
    sql: rawSql,
    embedClientConfig,
    fetchImpl,
    tenantId,
    principalId,
    query,
    overfetchLimit,
    generation = LIVE_GENERATION,
  } = args;

  if (query === "") return null;

  const embedSqlClient = createRawSqlClient(rawSql);
  const activeTable = await resolveActiveEmbedTable(embedSqlClient, tenantId);
  if (!activeTable) return null;

  if (!EMBED_TABLE_NAME_PATTERN.test(activeTable.tableName)) {
    throw new Error(
      `Resolved embed table name "${activeTable.tableName}" failed identifier validation`,
    );
  }

  const [vector] = await embedTexts([query], embedClientConfig, fetchImpl);
  if (!vector) return null;

  const efSearch = hnswEfSearch(overfetchLimit);

  // Placeholder numbering depends on whether a principal is present: the
  // null-principal fragment (VISIBILITY_PREDICATE_RAW_SQL_NULL_PRINCIPAL)
  // never references a principal placeholder at all, and Postgres cannot
  // infer a type for a varparam that no fragment of the query references
  // (error 42P18). So the principal value is only bound when a principal
  // exists, and each placeholder is derived from its position in the
  // params array rather than hand-numbered.
  const hasPrincipal = principalId !== null;
  const params: unknown[] = [tenantId];
  let visibilitySql = visibilityPredicateRawSql(hasPrincipal);
  if (hasPrincipal) {
    params.push(JSON.stringify([principalId]));
    visibilitySql = visibilitySql.replace(
      "$VISIBILITY_PRINCIPAL_JSON",
      `$${params.length}`,
    );
  }
  params.push(JSON.stringify(vector));
  const vectorParam = `$${params.length}`;
  params.push(overfetchLimit);
  const limitParam = `$${params.length}`;
  params.push(generation);
  const generationParam = `$${params.length}`;

  const sqlText = `
    SELECT c.id AS chunk_id, c.document_id AS document_id, c.version_id AS version_id,
           kv.version AS version, kv.status AS status, kd.title AS title, kd.kind AS kind,
           kd.adapter AS adapter, kd.external_ref AS external_ref,
           kv.created_by_kind AS created_by_kind, kv.generator_agent_id AS generator_agent_id,
           c.text AS snippet_text, kv.occurred_at AS occurred_at, kv.authority AS authority
    FROM ${activeTable.tableName} e
    JOIN knowledge_chunk c ON c.id = e.chunk_id
    JOIN knowledge_version kv ON kv.id = c.version_id
    JOIN knowledge_document kd ON kd.id = c.document_id
    WHERE e.tenant_id = $1 AND c.tenant_id = $1 AND kv.status = 'active'
      AND kv.generation = ${generationParam}
      AND ${visibilitySql}
    ORDER BY ${cosineDistanceExpr("e.embedding", vectorParam, activeTable.dims)} ASC
    LIMIT ${limitParam}
  `;

  // pgvector post-filters hnsw scans: with the default ef_search (40) a
  // selective tenant/ACL predicate can starve the LIMIT even though matches
  // exist. ef_search widens the fixed candidate pool; iterative_scan
  // (pgvector >= 0.8) additionally keeps scanning until the limit is
  // satisfied. Both are SET LOCAL, so nothing leaks into pooled session
  // state. relaxed_order can slightly disorder the dense channel's neighbor
  // ranks (and those ranks ARE the dense RRF input) — intentional trade-off
  // for selective-filter recall over strict distance order.
  const rows = await rawSql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL hnsw.ef_search = ${efSearch}`);
    const support = iterativeScanSupport.get(rawSql);
    if (support === true) {
      await tx.unsafe("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
    } else if (support === undefined) {
      try {
        await tx.savepoint((sp) =>
          sp.unsafe("SET LOCAL hnsw.iterative_scan = 'relaxed_order'"),
        );
        iterativeScanSupport.set(rawSql, true);
      } catch (err) {
        // 42704 (unrecognized configuration parameter) = pgvector < 0.8;
        // the savepoint rollback un-poisons the transaction and ef_search
        // alone still applies. Anything else is a real failure.
        if ((err as { code?: string }).code !== "42704") throw err;
        iterativeScanSupport.set(rawSql, false);
      }
    }
    return tx.unsafe(sqlText, params as never[]);
  });

  return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
    chunkId: row["chunk_id"] as string,
    documentId: row["document_id"] as string,
    versionId: row["version_id"] as string,
    version: row["version"] as number,
    status: row["status"] as CandidateRow["status"],
    title: row["title"] as string,
    kind: row["kind"] as string,
    adapter: row["adapter"] as string,
    externalRef: row["external_ref"] as string,
    createdByKind: row["created_by_kind"] as CandidateRow["createdByKind"],
    generatorAgentId: (row["generator_agent_id"] as string | null) ?? null,
    snippetText: row["snippet_text"] as string,
    // Dense candidates carry no ts_rank-comparable score; `rank` is
    // overwritten with the fused RRF score once fusion runs, and is never
    // read before that.
    rank: 0,
    occurredAt: new Date(row["occurred_at"] as string),
    authority: row["authority"] as number,
  }));
}

// Vectors for the MMR diversity pass, pulled from the tenant's ACTIVE
// per-model embedding table (never a superseded or inactive model's
// table). `pgvector` returns its column as text; the text form (`[1,2,3]`)
// is valid JSON, so `JSON.parse` is the exact inverse of the
// `JSON.stringify` the capture/embed pipeline writes on ingest.
async function fetchChunkVectors(
  rawSql: RawSql,
  tenantId: string,
  chunkIds: readonly string[],
): Promise<Map<string, number[]>> {
  if (chunkIds.length === 0) return new Map();

  const embedSqlClient = createRawSqlClient(rawSql);
  const activeTable = await resolveActiveEmbedTable(embedSqlClient, tenantId);
  if (!activeTable) return new Map();

  if (!EMBED_TABLE_NAME_PATTERN.test(activeTable.tableName)) {
    throw new Error(
      `Resolved embed table name "${activeTable.tableName}" failed identifier validation`,
    );
  }

  const sqlText = `
    SELECT chunk_id, embedding::text AS embedding_text
    FROM ${activeTable.tableName}
    WHERE tenant_id = $1 AND chunk_id = ANY($2::text[])
  `;

  const rows = await rawSql.unsafe(sqlText, [tenantId, chunkIds] as never[]);

  const map = new Map<string, number[]>();
  for (const row of rows as unknown as Record<string, unknown>[]) {
    const chunkId = row["chunk_id"] as string;
    const embeddingText = row["embedding_text"] as string;
    map.set(chunkId, JSON.parse(embeddingText) as number[]);
  }
  return map;
}

interface BoostedCandidate {
  row: CandidateRow;
  finalScore: number;
}

// Normalize the active-stage score (rerank score when reranking succeeded)
// to [0,1] within THIS batch, then multiply by the bounded authority and
// recency priors. Authority is applied HERE, not in
// `dedupeCandidatesPerDocument`'s prior (the caller must pass
// `applyAuthorityPrior: false` to that function on this path) — reconciling
// the two so authority is applied exactly once per search, never twice.
function applyBoosts(
  rows: readonly CandidateRow[],
  now: Date,
  recencyHalfLifeMs: number = RECENCY_HALF_LIFE_MS,
): BoostedCandidate[] {
  const normalized = normalizeScoresToUnit(rows.map((row) => row.rank));
  return rows.map((row, index) => {
    const normScore = normalized[index] ?? 0;
    const authorityMult = authorityBoostMultiplier(row.authority);
    const recencyMult = recencyBoostMultiplier(row.occurredAt, now, recencyHalfLifeMs);
    return { row, finalScore: normScore * authorityMult * recencyMult };
  });
}

const VALID_EMBED_API_STYLES = new Set(["openai", "tei", "ollama"]);

// The engine's `EngineConfig.embed.apiStyle` is a plain, operator-set string
// (config.ts has no arktype gate on it); `EmbedClientConfig` requires the
// literal union `embed-client.ts` dispatches on. Validated here, once, at
// the trust boundary between config and the client — an invalid value is an
// operator misconfiguration and must fail loudly, not silently degrade.
// Built from the engine's own operator-configured embed endpoint — a trusted
// URL, the same as KNOWLEDGE_DATABASE_URL.
function toEmbedClientConfig(embed: EngineConfig["embed"]): EmbedClientConfig {
  if (!VALID_EMBED_API_STYLES.has(embed.apiStyle)) {
    throw new Error(
      `Invalid EMBED_API_STYLE "${embed.apiStyle}" — must be one of: ${[...VALID_EMBED_API_STYLES].join(", ")}`,
    );
  }
  return {
    baseUrl: embed.baseUrl,
    modelId: embed.model,
    apiStyle: embed.apiStyle as EmbedClientConfig["apiStyle"],
    ...(embed.apiKey !== undefined ? { apiKey: embed.apiKey } : {}),
  };
}

// `EngineConfig.rerank` carries no `apiStyle` field — the engine currently
// wires only a TEI-compatible cross-encoder endpoint (the locked default
// model, `bge-reranker-v2-m3`, is TEI-servable); rerank apiStyle is hardcoded
// `"tei"` below. Absent `baseUrl` => rerank is unconfigured => `undefined`,
// same degrade-soft precedent as the embed config being absent upstream.
// Built from the engine's own operator-configured rerank endpoint — a trusted
// URL, the same as KNOWLEDGE_DATABASE_URL.
export function toRerankClientConfig(
  rerank: EngineConfig["rerank"],
): RerankClientConfig | undefined {
  if (!rerank.baseUrl) return undefined;
  return {
    baseUrl: rerank.baseUrl,
    apiStyle: "tei",
    ...(rerank.model !== undefined ? { model: rerank.model } : {}),
    ...(rerank.apiKey !== undefined ? { apiKey: rerank.apiKey } : {}),
    ...(rerank.maxDocChars !== undefined
      ? { maxDocChars: rerank.maxDocChars }
      : {}),
  };
}

export interface HybridSearchDeps {
  db: Db;
  sql: RawSql;
  config: EngineConfig;
  fetchImpl?: typeof fetch | undefined;
  // Injected so the recency boost is deterministic in tests; defaults to
  // the real clock in production.
  now?: Date | undefined;
}

export interface HybridSearchArgs {
  query: string;
  tenantId: string;
  principalId: string | null;
  k?: number | undefined;
  kinds?: string[] | undefined;
  entityIds?: string[] | undefined;
  // Defaults to 'live' — the normal capture/search behavior. A non-live
  // generation (a transform_run id, the replay pipeline) searches that replay's corpus
  // instead, applying its transform_config's retrieval tuning when
  // resolvable (see resolveGenerationSearchParams, transform.ts).
  generation?: string | undefined;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface HybridSearchResult {
  hits: SearchHit[];
  evidence: SearchResponse["evidence"];
  degraded?: DegradeFlag[];
}

/**
 * Hybrid retrieval: FTS + dense (active model's table only) → RRF fusion →
 * per-document dedupe → rerank + bounded authority/recency boosts + MMR
 * diversity pass (when a rerank endpoint is configured) → citation/evidence
 * finishing. Never fails solely because dense or rerank is down or
 * unconfigured — lexical always answers, and `degraded` reports
 * `"dense_unavailable"` / `"rerank_unavailable"` when either stage did not
 * contribute (fused+authority order is preserved unchanged on the
 * rerank-degraded path). `"rerank_query_too_long"` is a distinct rerank
 * degrade reason: the query alone left too little of the per-pair character
 * budget for the document, so the request was skipped rather than sent
 * guaranteed to exceed the model's token limit (see `RerankQueryTooLongError`
 * in rerank-client.ts).
 */
export async function hybridSearch(
  deps: HybridSearchDeps,
  args: HybridSearchArgs,
): Promise<HybridSearchResult> {
  const { db, sql: rawSql, config, fetchImpl = fetch, now = new Date() } = deps;
  const { tenantId, principalId, kinds, entityIds } = args;
  const generation = args.generation ?? LIVE_GENERATION;
  const query = args.query.trim();
  const k = Math.min(
    Math.max(1, Math.floor(args.k ?? DEFAULT_HYBRID_TOP_K)),
    MAX_K,
  );

  const hasStructuredFilter =
    (kinds && kinds.length > 0) || (entityIds && entityIds.length > 0);
  if (query === "" && !hasStructuredFilter) {
    throw new KnowledgeSearchInputError(
      "query must be non-empty unless kinds or entityIds is provided",
    );
  }

  // Live search never pays for this lookup — only a replay generation has a
  // transform_config to resolve, and every field the resolver doesn't
  // supply falls back to the exact engine default 'live' already used.
  const resolvedTuning =
    generation === LIVE_GENERATION
      ? null
      : await resolveGenerationSearchParams(db, generation);

  const authorityWeight = resolvedTuning?.authorityWeight ?? AUTHORITY_WEIGHT;
  const recencyHalfLifeMs =
    resolvedTuning?.recencyHalfLifeDays !== undefined
      ? resolvedTuning.recencyHalfLifeDays * MS_PER_DAY
      : RECENCY_HALF_LIFE_MS;
  const mmrLambda = resolvedTuning?.mmrLambda ?? MMR_LAMBDA;
  const overfetchMultiplier =
    resolvedTuning?.overfetch ?? DEFAULT_OVERFETCH_MULTIPLIER;

  const overfetchLimit = Math.min(
    k * clampOverfetchMultiplier(overfetchMultiplier),
    MAX_CANDIDATES_PER_CHANNEL,
  );

  const lexicalRows = await fetchLexicalCandidates({
    db,
    tenantId,
    principalId,
    query,
    ftsLanguage: config.ftsLanguage,
    overfetchLimit,
    kinds,
    entityIds,
    generation,
  });

  const embedClientConfig = toEmbedClientConfig(config.embed);
  const rerankConfig = resolvedTuning?.rerank ?? toRerankClientConfig(config.rerank);

  let denseRows: CandidateRow[] = [];
  let degraded: DegradeFlag[] | undefined;

  try {
    const dense = await fetchDenseCandidates({
      sql: rawSql,
      embedClientConfig,
      fetchImpl,
      tenantId,
      principalId,
      query,
      overfetchLimit,
      generation,
    });
    if (dense === null) {
      degraded = ["dense_unavailable"];
    } else {
      denseRows = dense;
    }
  } catch (err) {
    const errMessage = formatCaughtError(err);
    log.warn(
      `search: dense retrieval failed; falling back to lexical only: ${errMessage}`,
      { tenantId, error: errMessage },
    );
    degraded = ["dense_unavailable"];
  }

  const rowsByChunk = new Map<string, CandidateRow>();
  const channelsByChunk = new Map<string, Set<SearchChannel>>();

  for (const row of lexicalRows) {
    rowsByChunk.set(row.chunkId, row);
    channelsByChunk.set(row.chunkId, new Set<SearchChannel>(["lexical"]));
  }
  for (const row of denseRows) {
    if (!rowsByChunk.has(row.chunkId)) rowsByChunk.set(row.chunkId, row);
    const channels =
      channelsByChunk.get(row.chunkId) ?? new Set<SearchChannel>();
    channels.add("dense");
    channelsByChunk.set(row.chunkId, channels);
  }

  const fused = fuseRrf([
    toRankedCandidates(lexicalRows.map((r) => r.chunkId)),
    toRankedCandidates(denseRows.map((r) => r.chunkId)),
  ]);

  const mergedRows: CandidateRow[] = [];
  for (const candidate of fused) {
    const base = rowsByChunk.get(candidate.chunkId);
    if (!base) continue;
    mergedRows.push({ ...base, rank: candidate.score });
  }

  let truncated: CandidateRow[];
  // The final score per chunk, when the reranked path ran; absent on the
  // degraded/fallback path, where `toHit` falls back to its own
  // `authorityWeightedScore` default (unchanged behavior).
  let finalScoreByChunk: Map<string, number> | undefined;
  // The RAW cross-encoder score per chunk ([0,1] across TEI/Cohere/Voyage),
  // before RRF normalization and authority/recency boosts. Evidence derivation
  // reads THIS — not the boosted finalScore — so RERANK_STRONG_FLOOR gates on
  // the reranker's actual confidence rather than a batch-normalized top of ~1.
  let rawRerankScoreByChunk: Map<string, number> | undefined;

  if (rerankConfig) {
    try {
      // A replay's transform_config can supply its own rerank endpoint/model
      // (resolvedTuning?.rerank, above) that never passes through
      // mountKnowledgeEngine's startup validation — validate it here, on the
      // same terms as the mounted config, so a replay-authored mismatch
      // degrades to fused ranking (caught below) instead of silently
      // 413-ing every rerank call for that generation.
      validateRerankConfig(rerankConfig);

      const dedupedForRerank = dedupeCandidatesPerDocument(mergedRows, false);
      const rerankCandidates = dedupedForRerank.slice(
        0,
        RERANK_CANDIDATE_LIMIT,
      );

      const rerankResults = await rerankDocuments(
        query,
        rerankCandidates.map((row) => ({
          id: row.chunkId,
          text: row.snippetText,
        })),
        rerankConfig,
        fetchImpl,
      );
      const rerankScoreByChunk = new Map(
        rerankResults.map((result) => [result.id, result.score]),
      );
      rawRerankScoreByChunk = rerankScoreByChunk;

      const rerankedRows = rerankCandidates
        .map((row) => ({
          ...row,
          rank: rerankScoreByChunk.get(row.chunkId) ?? row.rank,
        }))
        .sort((a, b) => b.rank - a.rank);

      const boosted = applyBoosts(rerankedRows, now, recencyHalfLifeMs)
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, MMR_POOL_SIZE);

      const vectorsByChunk = await fetchChunkVectors(
        rawSql,
        tenantId,
        boosted.map((b) => b.row.chunkId),
      );

      const mmrItems: MmrItem[] = boosted.map((b) => ({
        id: b.row.chunkId,
        vector: vectorsByChunk.get(b.row.chunkId),
        score: b.finalScore,
      }));
      const orderedChunkIds = mmrRerank(mmrItems, mmrLambda, k);

      const boostedByChunk = new Map(boosted.map((b) => [b.row.chunkId, b]));
      finalScoreByChunk = new Map(
        boosted.map((b) => [b.row.chunkId, b.finalScore]),
      );
      truncated = orderedChunkIds
        .map((chunkId) => boostedByChunk.get(chunkId)?.row)
        .filter((row): row is CandidateRow => row !== undefined);
    } catch (err) {
      if (err instanceof RerankQueryTooLongError) {
        log.warn(
          `search: rerank skipped; query too long for the document budget, falling back to fused ranking: ${err.message}`,
          { tenantId, error: err.message },
        );
        degraded = [...(degraded ?? []), "rerank_query_too_long"];
      } else if (err instanceof RerankConfigError) {
        log.warn(
          `search: rerank config failed validation (possibly replay-supplied); falling back to fused ranking: ${err.message}`,
          { tenantId, generation, error: err.message },
        );
        degraded = [...(degraded ?? []), "rerank_unavailable"];
      } else {
        const errMessage = formatCaughtError(err);
        log.warn(
          `search: rerank failed; falling back to fused ranking: ${errMessage}`,
          { tenantId, error: errMessage },
        );
        degraded = [...(degraded ?? []), "rerank_unavailable"];
      }
      truncated = dedupeCandidatesPerDocument(
        mergedRows,
        true,
        authorityWeight,
      ).slice(0, k);
    }
  } else {
    degraded = [...(degraded ?? []), "rerank_unavailable"];
    truncated = dedupeCandidatesPerDocument(
      mergedRows,
      true,
      authorityWeight,
    ).slice(0, k);
  }

  const entityIdsByDocument = await attachEntityIds(db, tenantId, truncated);

  const hits: SearchHit[] = truncated.map((row) => ({
    ...toHit(
      row,
      [
        ...(channelsByChunk.get(row.chunkId) ??
          new Set<SearchChannel>(["lexical"])),
      ],
      finalScoreByChunk?.get(row.chunkId),
      authorityWeight,
    ),
    entity_ids: entityIdsByDocument.get(row.documentId) ?? [],
  }));

  const topTruncated = truncated[0];
  const rerankedTop =
    rawRerankScoreByChunk && topTruncated
      ? {
          rerankScore: rawRerankScoreByChunk.get(topTruncated.chunkId) ?? 0,
          authority: topTruncated.authority,
        }
      : undefined;
  const evidence = deriveHybridEvidence(lexicalRows, hits.length, rerankedTop);

  // One call per invocation, covering every degrade path above (dense down,
  // rerank down, rerank query-too-long) AND the fully healthy case
  // (`degraded` undefined) — see core/degrade-metrics.ts.
  recordDegrade(tenantId, degraded);

  return {
    hits,
    evidence,
    ...(degraded ? { degraded } : {}),
  };
}
