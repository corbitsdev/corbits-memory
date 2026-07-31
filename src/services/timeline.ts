/**
 * Durable capture timeline: recent knowledge_document rows for a principal,
 * filtered with the same visibility SQL and acl_block post-filter as search.
 */
import { and, desc, eq, type SQL } from "drizzle-orm";

import { readBlockList } from "../acl.ts";
import { LIVE_GENERATION } from "../core/generation.ts";
import type { Db } from "../db/client.ts";
import { knowledgeDocument, knowledgeVersion } from "../db/schema.ts";
import { log } from "../log.ts";
import { visibilityPredicateSql } from "./search.ts";

export type TimelineEvent = {
  at: string;
  title: string;
  source: string;
  tenantId: string;
  principalId: string;
};

export type TimelineRow = {
  id: string;
  title: string;
  tenantId: string;
  adapter: string;
  /** Activity time used for ordering and the wire `at` field (last_seen_at). */
  lastSeenAt: Date;
  attributes: unknown;
  principalId: string | null;
};

export type ListTimelineParams = {
  db: Db;
  tenantId: string;
  principalId: string;
  limit?: number;
};

export const DEFAULT_TIMELINE_LIMIT = 100;

/**
 * Active live-generation version join. Exported so unit tests pin the join
 * predicates without a live Postgres.
 */
export function timelineActiveVersionJoin(): SQL | undefined {
  return and(
    eq(knowledgeVersion.documentId, knowledgeDocument.id),
    eq(knowledgeVersion.status, "active"),
    eq(knowledgeVersion.generation, LIVE_GENERATION),
  );
}

/**
 * Tenant + visibility WHERE clause — same visibilityPredicateSql as search.
 * Exported so unit tests pin the SQL composition to listTimelineEvents.
 */
export function timelineWhere(
  tenantId: string,
  principalId: string,
): SQL | undefined {
  return and(
    eq(knowledgeDocument.tenantId, tenantId),
    visibilityPredicateSql(principalId),
  );
}

/**
 * Whether a timeline row is withheld from `principalId` under the same
 * fail-closed `readBlockList` rules search uses via `blockedDocumentIds`.
 *
 * Returns why so callers can log unreadable ACLs without inventing a second
 * membership interpretation.
 */
export function timelineRowBlock(
  attributes: Record<string, unknown> | null,
  principalId: string,
): "allow" | "blocked" | "unreadable" {
  const read = readBlockList(attributes?.["acl_block"]);
  if (read.kind === "absent") return "allow";
  if (read.kind === "unreadable") return "unreadable";
  return read.principalIds.includes(principalId) ? "blocked" : "allow";
}

/**
 * Pure block post-filter used by listTimelineEvents. Exported for unit tests
 * so the leak guard does not need a live Postgres.
 *
 * Rows that fail closed (unreadable acl_block) are dropped; their ids are
 * returned in `unreadableIds` for capped audit logging (same posture as search).
 */
export function filterTimelineRowsForPrincipal(
  rows: readonly TimelineRow[],
  principalId: string,
  limit: number,
): { events: TimelineEvent[]; unreadableIds: string[] } {
  const events: TimelineEvent[] = [];
  const unreadableIds: string[] = [];
  for (const row of rows) {
    if (events.length >= limit) break;
    const attributes =
      row.attributes && typeof row.attributes === "object"
        ? (row.attributes as Record<string, unknown>)
        : null;
    // Same gate as search: readBlockList fail-closed membership.
    const decision = timelineRowBlock(attributes, principalId);
    if (decision === "unreadable") {
      unreadableIds.push(row.id);
      continue;
    }
    if (decision === "blocked") continue;
    events.push({
      at: row.lastSeenAt.toISOString(),
      title: row.title,
      source: row.adapter,
      tenantId: row.tenantId,
      principalId: row.principalId ?? "",
    });
  }
  return { events, unreadableIds };
}

/**
 * Recent captures visible to `principalId` under the same ACL rules as search.
 * Visibility is applied in SQL; acl_block is a post-filter via `readBlockList`
 * (the same helper search uses through `blockedDocumentIds`).
 *
 * One row per document (active live version), ordered by last_seen_at DESC.
 * Wire `source` is the document adapter (HTTP capture defaults to "mcp").
 * Wire `principalId` is knowledge_version.created_by_principal_id.
 */
export async function listTimelineEvents(
  params: ListTimelineParams,
): Promise<TimelineEvent[]> {
  const limit = Math.min(
    Math.max(params.limit ?? DEFAULT_TIMELINE_LIMIT, 1),
    DEFAULT_TIMELINE_LIMIT,
  );
  // Overfetch so silent block drops still leave a full page when possible.
  // Always scan at least DEFAULT_TIMELINE_LIMIT candidates so a small `limit`
  // is not starved by a dense recent block list.
  const overfetch = Math.min(
    Math.max(limit * 3, DEFAULT_TIMELINE_LIMIT),
    DEFAULT_TIMELINE_LIMIT * 3,
  );

  const rows = await params.db
    .select({
      id: knowledgeDocument.id,
      title: knowledgeDocument.title,
      tenantId: knowledgeDocument.tenantId,
      adapter: knowledgeDocument.adapter,
      lastSeenAt: knowledgeDocument.lastSeenAt,
      attributes: knowledgeDocument.attributes,
      principalId: knowledgeVersion.createdByPrincipalId,
    })
    .from(knowledgeDocument)
    .innerJoin(knowledgeVersion, timelineActiveVersionJoin())
    .where(timelineWhere(params.tenantId, params.principalId))
    .orderBy(desc(knowledgeDocument.lastSeenAt))
    .limit(overfetch);

  const { events, unreadableIds } = filterTimelineRowsForPrincipal(
    rows,
    params.principalId,
    limit,
  );

  if (unreadableIds.length > 0) {
    const sampleLimit = 20;
    const documentIds = unreadableIds.slice(0, sampleLimit);
    const more =
      unreadableIds.length > sampleLimit
        ? ` (+${unreadableIds.length - sampleLimit} more)`
        : "";
    log.warn(
      `timeline: ${unreadableIds.length} document(s) had an unreadable acl_block; withholding: ${documentIds.join(", ")}${more}`,
      { count: unreadableIds.length, documentIds },
    );
  }

  return events;
}
