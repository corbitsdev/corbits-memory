/**
 * Timeline / recent — tenant-scoped document history.
 *
 * Document access is Interchange grant tags (same as search): creator always
 * sees own docs; otherwise any accessTag that authorize(..., tag, "search")
 * allows. No visibility SQL, no acl_block post-filter.
 *
 * See docs/AUTHZ-DOCUMENT-ACCESS.md.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import { canAccessDocument } from "../grant-tags.ts";
import { LIVE_GENERATION } from "../core/generation.ts";

import type { Db } from "../db/client.ts";
import { memoryDocument, memoryVersion } from "../db/schema.ts";
import { log } from "../log.ts";

export type TimelineEvent = {
  at: string;
  title: string;
  source: string;
  tenantId: string;
  principalId: string;
};

export type ListTimelineParams = {
  db: Db;
  tenantId: string;
  principalId: string;
  limit?: number;
  /** Host grant store — required for non-creator document access. */
  grants?: GrantStore;
  conditionRegistry?: ConditionRegistry;
  /**
   * Replay-generation tag. Defaults to live so staged replay versions never
   * appear in the default timeline (matches hybrid search).
   */
  generation?: string;
};

export type TimelineRow = {
  documentId: string;
  title: string;
  adapter: string;
  externalRef: string;
  occurredAt: Date;
  createdByPrincipalId: string | null;
  accessTags: string[] | null;
};

/** Over-fetch factor before grant-tag filter (same idea as hybrid overfetch). */
const TIMELINE_OVERFETCH = 4;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Tenant-only WHERE — document access is applied in application code.
 */
export function timelineWhere(tenantId: string) {
  return eq(memoryDocument.tenantId, tenantId);
}

/**
 * Active-version join for timeline: status + generation (live by default).
 * Exported so tests can assert the generation predicate without a live DB.
 */
export function activeTimelineVersionJoin(
  generation: string = LIVE_GENERATION,
) {
  return and(
    eq(memoryVersion.documentId, memoryDocument.id),
    eq(memoryVersion.status, "active"),
    eq(memoryVersion.generation, generation),
  );
}

/**
 * Filter raw timeline rows to those the principal may see under grant tags.
 */
export async function filterTimelineRows(
  rows: readonly TimelineRow[],
  params: {
    principalId: string;
    tenantId: string;
    grants?: GrantStore;
    conditionRegistry?: ConditionRegistry;
  },
): Promise<{ events: TimelineEvent[]; withheld: number }> {
  const events: TimelineEvent[] = [];
  let withheld = 0;

  for (const row of rows) {
    if (!params.grants) {
      // Safe default: creator-only when no GrantStore is mounted.
      if (row.createdByPrincipalId !== params.principalId) {
        withheld += 1;
        continue;
      }
    } else {
      const ok = await canAccessDocument({
        grants: params.grants,
        tenantId: params.tenantId,
        principalId: params.principalId,
        createdByPrincipalId: row.createdByPrincipalId,
        accessTags: row.accessTags ?? [],
        ...(params.conditionRegistry !== undefined
          ? { conditionRegistry: params.conditionRegistry }
          : {}),
      });
      if (!ok) {
        withheld += 1;
        continue;
      }
    }

    events.push({
      at: row.occurredAt.toISOString(),
      title: row.title,
      source: `${row.adapter}:${row.externalRef}`,
      tenantId: params.tenantId,
      principalId: params.principalId,
    });
  }

  return { events, withheld };
}

/**
 * List recent document events for a tenant, filtered by grant-tag access.
 * Only active versions in the requested generation (default live) appear.
 */
export async function listTimelineEvents(
  params: ListTimelineParams,
): Promise<TimelineEvent[]> {
  const limit = Math.min(
    Math.max(params.limit ?? DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const fetchLimit = Math.min(limit * TIMELINE_OVERFETCH, MAX_LIMIT * TIMELINE_OVERFETCH);
  const generation = params.generation ?? LIVE_GENERATION;

  const rows = await params.db
    .select({
      documentId: memoryDocument.id,
      title: memoryDocument.title,
      adapter: memoryDocument.adapter,
      externalRef: memoryDocument.externalRef,
      occurredAt: memoryVersion.occurredAt,
      createdByPrincipalId: memoryVersion.createdByPrincipalId,
      accessTags: memoryDocument.accessTags,
    })
    .from(memoryDocument)
    .innerJoin(memoryVersion, activeTimelineVersionJoin(generation))
    .where(timelineWhere(params.tenantId))
    .orderBy(desc(memoryVersion.occurredAt))
    .limit(fetchLimit);

  const { events, withheld } = await filterTimelineRows(rows, {
    principalId: params.principalId,
    tenantId: params.tenantId,
    ...(params.grants !== undefined ? { grants: params.grants } : {}),
    ...(params.conditionRegistry !== undefined
      ? { conditionRegistry: params.conditionRegistry }
      : {}),
  });

  if (withheld > 0) {
    log.info(
      `timeline: withheld ${withheld} document(s) under grant-tag access for principal ${params.principalId}`,
    );
  }

  return events.slice(0, limit);
}
