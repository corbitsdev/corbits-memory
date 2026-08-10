/**
 * Grant-tag helpers for document access (Interchange `@intx/authz`).
 *
 * Spec: docs/AUTHZ-DOCUMENT-ACCESS.md
 *
 * - Capability checks (add/search on `memory`) live on the HTTP mount.
 * - Document access: creator always sees own docs; otherwise any `accessTag`
 *   that `authorize(…, tag, "search")` allows.
 * - Share sugars mint tags; peer grants are materialized separately when the
 *   host provides a WritableGrantStore (see services/share-grants.ts).
 */
import { authorize } from "@intx/authz";
import type { ConditionRegistry, GrantStore } from "@intx/authz";

export function ownerTag(principalId: string): string {
  return `memory.owner:${principalId}`;
}

export function tenantTag(tenantId: string): string {
  return `memory.tenant:${tenantId}`;
}

/** Share sugar — maps only to tags (no visibility modes / block lists). */
export type ShareSugar = {
  /** Include memory.tenant:<tenantId> */
  tenant?: boolean;
  /** Include memory.owner:<id> for each peer */
  principals?: string[];
  /** Explicit resource tags (host grant space) */
  tags?: string[];
};

export type ResolveAccessTagsParams = {
  principalId: string;
  tenantId: string;
  /** Explicit tags from the caller (merged with defaults/share). */
  accessTags?: string[];
  share?: ShareSugar;
};

/**
 * Resolve the tag set written on add.
 * Always includes memory.owner:<caller>. Never invents visibility modes.
 */
export function resolveAccessTags(params: ResolveAccessTagsParams): string[] {
  const tags = new Set<string>();
  tags.add(ownerTag(params.principalId));

  if (params.accessTags) {
    for (const t of params.accessTags) {
      if (typeof t === "string" && t.trim() !== "") tags.add(t.trim());
    }
  }

  const share = params.share;
  if (share) {
    if (share.tenant) tags.add(tenantTag(params.tenantId));
    if (share.principals) {
      for (const p of share.principals) {
        if (typeof p === "string" && p.trim() !== "") {
          tags.add(ownerTag(p.trim()));
        }
      }
    }
    if (share.tags) {
      for (const t of share.tags) {
        if (typeof t === "string" && t.trim() !== "") tags.add(t.trim());
      }
    }
  }

  return [...tags];
}

export type CanAccessDocumentParams = {
  grants: GrantStore;
  tenantId: string;
  principalId: string;
  createdByPrincipalId: string | null | undefined;
  accessTags: readonly string[];
  conditionRegistry?: ConditionRegistry;
};

/**
 * True when the principal may see this document under grant-tag rules.
 * Creator is always allowed (implicit owner). Everyone else needs an allow
 * on at least one accessTag for action "search".
 */
export async function canAccessDocument(
  params: CanAccessDocumentParams,
): Promise<boolean> {
  if (
    params.createdByPrincipalId != null &&
    params.createdByPrincipalId !== "" &&
    params.createdByPrincipalId === params.principalId
  ) {
    return true;
  }

  for (const tag of params.accessTags) {
    if (!tag) continue;
    const decision = await authorize(
      params.grants,
      params.principalId,
      params.tenantId,
      tag,
      "search",
      params.conditionRegistry,
    );
    if (decision.effect === "allow") return true;
  }
  return false;
}

/**
 * Filter a list of docs to those the principal may see.
 */
export async function filterAccessibleDocuments<
  T extends {
    accessTags?: readonly string[] | null;
    createdByPrincipalId?: string | null;
  },
>(
  docs: readonly T[],
  params: {
    grants: GrantStore;
    tenantId: string;
    principalId: string;
    conditionRegistry?: ConditionRegistry;
  },
): Promise<T[]> {
  const out: T[] = [];
  for (const doc of docs) {
    const ok = await canAccessDocument({
      grants: params.grants,
      tenantId: params.tenantId,
      principalId: params.principalId,
      createdByPrincipalId: doc.createdByPrincipalId,
      accessTags: doc.accessTags ?? [],
      ...(params.conditionRegistry !== undefined
        ? { conditionRegistry: params.conditionRegistry }
        : {}),
    });
    if (ok) out.push(doc);
  }
  return out;
}
