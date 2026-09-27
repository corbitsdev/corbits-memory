/**
 * Retention write paths (CL-5871).
 * See docs/RETENTION.md.
 */
import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  memoryChunk,
  memoryDocument,
  memoryVersion,
  rawCapture,
} from "../db/schema.js";
import type { RetentionClass } from "../core/enums.js";

export type RetentionMutationResult = {
  versionId: string;
  documentId: string;
  status: string;
};

export async function deprecateVersion(
  db: Db,
  input: {
    tenantId: string;
    versionId: string;
    reason?: string;
  },
): Promise<RetentionMutationResult | null> {
  const now = new Date();
  const updated = await db
    .update(memoryVersion)
    .set({
      status: "deprecated",
      deprecatedAt: now,
      deprecatedReason: input.reason ?? "deprecated",
    })
    .where(
      and(
        eq(memoryVersion.tenantId, input.tenantId),
        eq(memoryVersion.id, input.versionId),
        inArray(memoryVersion.status, ["active", "superseded"]),
      ),
    )
    .returning({
      versionId: memoryVersion.id,
      documentId: memoryVersion.documentId,
      status: memoryVersion.status,
    });
  return updated[0] ?? null;
}

/**
 * Tombstone: hide from search/feed, redact chunk and raw capture text, keep
 * rows for audit.
 * Applies to the document's live active (or deprecated) versions.
 */
export async function tombstoneDocument(
  db: Db,
  input: {
    tenantId: string;
    documentId: string;
    reason?: string;
  },
): Promise<{ versions: number }> {
  const now = new Date();
  const versions = await db
    .update(memoryVersion)
    .set({
      status: "tombstoned",
      deprecatedAt: now,
      deprecatedReason: input.reason ?? "tombstoned",
    })
    .where(
      and(
        eq(memoryVersion.tenantId, input.tenantId),
        eq(memoryVersion.documentId, input.documentId),
        inArray(memoryVersion.status, ["active", "deprecated", "superseded"]),
      ),
    )
    .returning({ id: memoryVersion.id });

  if (versions.length > 0) {
    await db
      .update(memoryChunk)
      .set({ text: "[redacted]" })
      .where(
        and(
          eq(memoryChunk.tenantId, input.tenantId),
          eq(memoryChunk.documentId, input.documentId),
        ),
      );
    await db
      .update(rawCapture)
      .set({ rawText: "[redacted]", rawBytes: null })
      .where(
        inArray(
          rawCapture.id,
          db
            .select({ id: memoryVersion.rawCaptureId })
            .from(memoryVersion)
            .where(
              and(
                eq(memoryVersion.tenantId, input.tenantId),
                eq(memoryVersion.documentId, input.documentId),
              ),
            ),
        ),
      );
  }
  return { versions: versions.length };
}

/**
 * Hard-delete a document (cascade chunks/versions/edges via FKs where set)
 * and the raw captures only its versions referenced.
 * Blocked for durable retention_class on any non-tombstoned version.
 */
export async function hardDeleteDocument(
  db: Db,
  input: {
    tenantId: string;
    documentId: string;
  },
): Promise<{ deleted: boolean; reason?: string }> {
  const durable = await db
    .select({ id: memoryVersion.id })
    .from(memoryVersion)
    .where(
      and(
        eq(memoryVersion.tenantId, input.tenantId),
        eq(memoryVersion.documentId, input.documentId),
        eq(memoryVersion.retentionClass, "durable"),
        sql`${memoryVersion.status} <> 'tombstoned'`,
      ),
    )
    .limit(1);

  if (durable.length > 0) {
    return {
      deleted: false,
      reason: "document has durable retention_class versions; tombstone first",
    };
  }

  return db.transaction(async (tx) => {
    const captures = await tx
      .selectDistinct({ id: memoryVersion.rawCaptureId })
      .from(memoryVersion)
      .where(
        and(
          eq(memoryVersion.tenantId, input.tenantId),
          eq(memoryVersion.documentId, input.documentId),
          isNotNull(memoryVersion.rawCaptureId),
        ),
      );
    const deleted = await tx
      .delete(memoryDocument)
      .where(
        and(
          eq(memoryDocument.tenantId, input.tenantId),
          eq(memoryDocument.id, input.documentId),
        ),
      )
      .returning({ id: memoryDocument.id });
    const captureIds = captures.flatMap((c) => (c.id === null ? [] : [c.id]));
    if (captureIds.length > 0) {
      await tx
        .delete(rawCapture)
        .where(
          and(
            inArray(rawCapture.id, captureIds),
            sql`NOT EXISTS (SELECT 1 FROM ${memoryVersion} WHERE ${memoryVersion.rawCaptureId} = ${rawCapture.id})`,
          ),
        );
    }
    return { deleted: deleted.length > 0 };
  });
}

/**
 * Sweep ephemeral versions past valid_until (or 7d default from ingested_at).
 * Auto-deprecates expired ephemeral versions (core stays cron-free — host
 * schedules this). Hard-delete remains an explicit separate verb.
 */
export async function sweepEphemeral(
  db: Db,
  input: {
    tenantId: string;
    now?: Date;
  },
): Promise<{ versionsDeprecated: number }> {
  const now = input.now ?? new Date();
  const expired = await db
    .update(memoryVersion)
    .set({
      status: "deprecated",
      deprecatedAt: now,
      deprecatedReason: "ephemeral_ttl",
    })
    .where(
      and(
        eq(memoryVersion.tenantId, input.tenantId),
        eq(memoryVersion.retentionClass, "ephemeral"),
        eq(memoryVersion.status, "active"),
        or(
          and(
            isNotNull(memoryVersion.validUntil),
            lt(memoryVersion.validUntil, now),
          ),
          and(
            sql`${memoryVersion.validUntil} IS NULL`,
            lt(
              memoryVersion.ingestedAt,
              new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
            ),
          ),
        ),
      ),
    )
    .returning({ id: memoryVersion.id });

  return { versionsDeprecated: expired.length };
}

export async function setRetentionClass(
  db: Db,
  input: {
    tenantId: string;
    versionId: string;
    retentionClass: RetentionClass;
  },
): Promise<RetentionMutationResult | null> {
  const updated = await db
    .update(memoryVersion)
    .set({ retentionClass: input.retentionClass })
    .where(
      and(
        eq(memoryVersion.tenantId, input.tenantId),
        eq(memoryVersion.id, input.versionId),
      ),
    )
    .returning({
      versionId: memoryVersion.id,
      documentId: memoryVersion.documentId,
      status: memoryVersion.status,
    });
  return updated[0] ?? null;
}
