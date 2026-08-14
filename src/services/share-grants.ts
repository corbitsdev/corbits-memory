/**
 * Share materialization — tags alone are not grants (CL-5873).
 *
 * Locked decisions (Greybeard):
 * - Approver default: **source owner** (not tenant admin).
 * - Staging: **write-narrow-then-widen** (no pending_share status).
 * - Ask-on-read: design-only in v1 (canAccessDocument still fail-closed on ask).
 *
 * Origin is constrained by `@intx/types` to system|role|creator|invoker —
 * memory-share provenance lives in `conditions.memoryShare` (audit payload).
 * Authz skips grants with non-null conditions unless a registry is provided;
 * use `MEMORY_SHARE_CONDITION_REGISTRY` (merged automatically in resolveGrantConfig).
 */
import type { ConditionRegistry, GrantRule } from "@intx/authz";
import { newId } from "../core/id.ts";
import type { ShareSugar } from "../grant-tags.ts";
import type { WritableGrantStore } from "../ports/writable-grant-store.ts";

/** Document-scoped resource tag for peer share grants. */
export function documentTag(documentId: string): string {
  return `memory.doc:${documentId}`;
}

export const MEMORY_SHARE_CONDITION_KEY = "memoryShare";

/**
 * Audit payload stored under conditions.memoryShare.
 * The evaluator always returns true — this is provenance, not a gate.
 */
export type MemoryShareCondition = {
  sharedBy: string;
  sourceVersionId: string;
  documentId: string;
  tenantId: string;
};

/**
 * Default registry so share grants with conditions are not fail-closed-skipped.
 * Hosts may override the key; resolveGrantConfig merges host keys on top.
 */
export const MEMORY_SHARE_CONDITION_REGISTRY: ConditionRegistry = {
  [MEMORY_SHARE_CONDITION_KEY]: () => true,
};

export type MaterializeShareGrantsInput = {
  tenantId: string;
  /** Principal who initiated the share (source owner / creator). */
  sharedByPrincipalId: string;
  documentId: string;
  /** Version that carried the share (for audit receipt). */
  sourceVersionId: string;
  share: ShareSugar;
};

/**
 * Build grant rules for peer principals on a document-scoped tag.
 *
 * - `share.principals`: one allow/search grant per peer on `memory.doc:<id>`.
 * - `share.tenant` / `share.tags`: do **not** auto-mint principal grants —
 *   those rely on host role/pattern grants already present on the tag.
 *
 * Returns rules only (does not write). Caller applies via WritableGrantStore.
 */
export function buildShareGrants(
  input: MaterializeShareGrantsInput,
): GrantRule[] {
  const peers = input.share.principals ?? [];
  if (peers.length === 0) return [];

  const resource = documentTag(input.documentId);
  const rules: GrantRule[] = [];

  for (const peer of peers) {
    if (typeof peer !== "string" || peer.trim() === "") continue;
    const principalId = peer.trim();
    // Never grant the owner to themselves via share — creator path already covers.
    if (principalId === input.sharedByPrincipalId) continue;

    const sharePayload: MemoryShareCondition = {
      sharedBy: input.sharedByPrincipalId,
      sourceVersionId: input.sourceVersionId,
      documentId: input.documentId,
      tenantId: input.tenantId,
    };

    rules.push({
      id: newId("mgrt"),
      principalId,
      resource,
      action: "search",
      effect: "allow",
      origin: "system",
      roleId: null,
      expiresAt: null,
      // Single condition key so hosts only need one registry entry.
      // Nested object carries audit provenance without extra evaluators.
      conditions: {
        [MEMORY_SHARE_CONDITION_KEY]: sharePayload,
      },
    });
  }

  return rules;
}

/**
 * Write share grants to the host store.
 */
export async function materializeShareGrants(
  store: WritableGrantStore,
  input: MaterializeShareGrantsInput,
): Promise<{ written: number; grants: GrantRule[] }> {
  const grants = buildShareGrants(input);
  for (const grant of grants) {
    await store.putGrant(grant);
  }
  return { written: grants.length, grants };
}

/**
 * Split proposed access tags into those already covered by the source
 * audience vs those that widen (need source-owner approval).
 *
 * Write-narrow-then-widen: caller writes with `allowed` only, then widens
 * after approval by appending `needsApproval` tags + materializing grants.
 */
export function splitAudienceWiden(
  sourceAccessTags: readonly string[],
  proposedAccessTags: readonly string[],
): { allowed: string[]; needsApproval: string[] } {
  const source = new Set(sourceAccessTags);
  const allowed: string[] = [];
  const needsApproval: string[] = [];
  for (const tag of proposedAccessTags) {
    if (source.has(tag)) allowed.push(tag);
    else needsApproval.push(tag);
  }
  return { allowed, needsApproval };
}

/** Receipt shape stored on version attributes after widen approval. */
export type ShareWidenReceipt = {
  approvedBy: string;
  approvedAt: string;
  tags: string[];
  sourceVersionId: string;
};

export function shareWidenReceipt(params: {
  approvedBy: string;
  tags: readonly string[];
  sourceVersionId: string;
  approvedAt?: Date;
}): ShareWidenReceipt {
  return {
    approvedBy: params.approvedBy,
    approvedAt: (params.approvedAt ?? new Date()).toISOString(),
    tags: [...params.tags],
    sourceVersionId: params.sourceVersionId,
  };
}
