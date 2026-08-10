/**
 * Capture feed — cursor pull of new versions for the resident distiller (CL-5868).
 * See docs/FEED.md.
 */
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import {
  memoryDocument,
  memoryVersion,
} from "../db/schema.ts";
import { LIVE_GENERATION } from "../core/generation.ts";

export const FEED_LIMIT_MIN = 1;
export const FEED_LIMIT_MAX = 100;
export const FEED_LIMIT_DEFAULT = 50;

export type FeedArgs = {
  tenantId: string;
  /** Exclusive cursor: return rows with feed_seq > after. Default 0. */
  after?: number;
  limit?: number;
  /** Skip versions written by this generator (loop-safe for distiller). */
  excludeGenerator?: string;
};

export type FeedEntry = {
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
  /** Resource tags for grant post-filter (same as search). */
  accessTags: string[];
  createdByPrincipalId: string | null;
};

export type FeedResult = {
  entries: FeedEntry[];
  /** Highest feedSeq in this page (consumer stores as next `after`). */
  nextCursor: number | null;
};

export class FeedInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "FeedInputError";
  }
}

export async function fetchFeed(
  db: Db,
  args: FeedArgs,
): Promise<FeedResult> {
  const after = Math.max(0, Math.floor(args.after ?? 0));
  const limit = Math.min(
    FEED_LIMIT_MAX,
    Math.max(FEED_LIMIT_MIN, Math.floor(args.limit ?? FEED_LIMIT_DEFAULT)),
  );
  const exclude = args.excludeGenerator?.trim() || undefined;

  const conditions = [
    eq(memoryVersion.tenantId, args.tenantId),
    eq(memoryVersion.generation, LIVE_GENERATION),
    // Live feed: active or superseded commits only. Deprecated / tombstoned
    // versions are retention write-path outcomes and stay out of the cursor stream.
    sql`${memoryVersion.status} IN ('active', 'superseded')`,
    gt(memoryVersion.feedSeq, after),
  ];

  if (exclude) {
    conditions.push(
      or(
        isNull(memoryVersion.generatorAgentId),
        ne(memoryVersion.generatorAgentId, exclude),
      )!,
    );
  }

  const rows = await db
    .select({
      feedSeq: memoryVersion.feedSeq,
      versionId: memoryVersion.id,
      documentId: memoryVersion.documentId,
      kind: memoryDocument.kind,
      title: memoryDocument.title,
      status: memoryVersion.status,
      createdByKind: memoryVersion.createdByKind,
      generatorAgentId: memoryVersion.generatorAgentId,
      provenance: memoryVersion.provenance,
      occurredAt: memoryVersion.occurredAt,
      createdAt: memoryVersion.ingestedAt,
      accessTags: memoryDocument.accessTags,
      createdByPrincipalId: memoryVersion.createdByPrincipalId,
    })
    .from(memoryVersion)
    .innerJoin(
      memoryDocument,
      eq(memoryDocument.id, memoryVersion.documentId),
    )
    .where(and(...conditions))
    .orderBy(asc(memoryVersion.feedSeq))
    .limit(limit);

  const entries: FeedEntry[] = rows.map((r) => ({
    feedSeq: Number(r.feedSeq),
    versionId: r.versionId,
    documentId: r.documentId,
    kind: r.kind,
    title: r.title,
    status: r.status,
    createdByKind: r.createdByKind,
    generatorAgentId: r.generatorAgentId,
    provenance: r.provenance,
    occurredAt: r.occurredAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    accessTags: (r.accessTags as string[] | null) ?? [],
    createdByPrincipalId: r.createdByPrincipalId,
  }));

  const nextCursor =
    entries.length > 0 ? entries[entries.length - 1]!.feedSeq : null;

  return { entries, nextCursor };
}
