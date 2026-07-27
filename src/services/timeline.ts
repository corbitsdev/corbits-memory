/**
 * Durable capture timeline: recent knowledge_document rows for a principal,
 * filtered with the same visibility SQL and acl_block post-filter as search.
 */
import { and, desc, eq, type SQL } from "drizzle-orm";

import {
  isBlockedForPrincipal,
  parseAclBlockAttribute,
} from "../acl.ts";
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
 * Pure block post-filter used by listTimelineEvents. Exported for unit tests
 * so the leak guard does not need a live Postgres.
 *
 * Rows that fail closed (corrupt acl_block) are dropped and counted in the
 * returned `failClosedCount` so callers can log without leaking document ids.
 */
export function filterTimelineRowsForPrincipal(
  rows: readonly TimelineRow[],
  principalId: string,
  limit: number,
): { events: TimelineEvent[]; failClosedCount: number } {
  const events: TimelineEvent[] = [];
  let failClosedCount = 0;
  for (const row of rows) {
    if (events.length >= limit) break;
    const attributes =
      row.attributes && typeof row.attributes === "object"
        ? (row.attributes as Record<string, unknown>)
        : null;
    const parsed = parseAclBlockAttribute(attributes?.["acl_block"]);
    if (parsed.kind === "fail_closed") {
      failClosedCount += 1;
      continue;
    }
    if (isBlockedForPrincipal(parsed, principalId)) continue;
    events.push({
      at: row.lastSeenAt.toISOString(),
      title: row.title,
      source: row.adapter,
      tenantId: row.tenantId,
      principalId: row.principalId ?? "",
    });
  }
  return { events, failClosedCount };
}

/**
 * Recent captures visible to `principalId` under the same ACL rules as search.
 * Visibility is applied in SQL; acl_block is a post-filter (fail-closed).
 *
 * One row per document (active live version), ordered by last_seen_at DESC.
 * Wire `source` is the document adapter (HTTP capture defaults to "mcp").
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

  const { events, failClosedCount } = filterTimelineRowsForPrincipal(
    rows,
    params.principalId,
    limit,
  );

  if (failClosedCount > 0) {
    log.warn(
      `timeline: unparseable acl_block, withheld ${failClosedCount} document(s)`,
      { withheld: failClosedCount },
    );
  }

  return events;
}
