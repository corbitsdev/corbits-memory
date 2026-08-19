/**
 * Ownership gate for retention writes (CL-6288).
 *
 * A share grant lets a peer *see* a document via `canAccessDocument`
 * (grant-tags.ts) — it must never let them forget or purge it. Retention
 * routes check creator identity here, independent of the document's
 * access tags, before ever calling into services/retention.ts.
 *
 * Raw `sql` (not the Drizzle `Db`) so unit tests can mock the query
 * directly, matching the ACL-load pattern in memory.ts's search path.
 */
import type { RawSql } from "../db/client.ts";

export type OwnerLookup = {
  /** False when no matching document/version row exists. */
  exists: boolean;
  ownerId: string | null;
};

/**
 * A document's creator is the `created_by_principal_id` of its first
 * version — stable regardless of which versions are later deprecated,
 * tombstoned, or added, and independent of `accessTags`.
 */
export async function resolveDocumentOwner(
  sql: RawSql,
  input: { tenantId: string; documentId: string },
): Promise<OwnerLookup> {
  const rows = await sql<{ created_by_principal_id: string | null }[]>`
    SELECT created_by_principal_id
    FROM "memory"."version"
    WHERE tenant_id = ${input.tenantId}
      AND document_id = ${input.documentId}
    ORDER BY version ASC
    LIMIT 1
  `;
  if (rows.length === 0) return { exists: false, ownerId: null };
  return { exists: true, ownerId: rows[0]!.created_by_principal_id };
}

/** A version's own creator (retention class is set per version). */
export async function resolveVersionOwner(
  sql: RawSql,
  input: { tenantId: string; versionId: string },
): Promise<OwnerLookup> {
  const rows = await sql<{ created_by_principal_id: string | null }[]>`
    SELECT created_by_principal_id
    FROM "memory"."version"
    WHERE tenant_id = ${input.tenantId}
      AND id = ${input.versionId}
    LIMIT 1
  `;
  if (rows.length === 0) return { exists: false, ownerId: null };
  return { exists: true, ownerId: rows[0]!.created_by_principal_id };
}

/** True only when the row exists AND its owner matches the caller. */
export function isOwner(lookup: OwnerLookup, principalId: string): boolean {
  return lookup.exists && lookup.ownerId === principalId;
}
