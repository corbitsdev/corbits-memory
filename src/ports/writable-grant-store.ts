/**
 * Host grant store that can materialize share grants.
 *
 * `@intx/authz` `GrantStore` is read-only (`collectGrants`). Memory never
 * owns the grant plane — hosts that want share-on-add to work pass a store
 * implementing this write seam.
 */
import type { GrantRule, GrantStore } from "@intx/authz";

export type WritableGrantStore = GrantStore & {
  /**
   * Insert or replace a grant by id. Hosts map this onto their control-plane
   * grant table. Memory only calls this for share materialization.
   */
  putGrant(grant: GrantRule): Promise<void>;
};

export function isWritableGrantStore(
  store: GrantStore | undefined,
): store is WritableGrantStore {
  return (
    store !== undefined &&
    typeof (store as WritableGrantStore).putGrant === "function"
  );
}

/**
 * In-memory writable store for tests. Collects by principalId like
 * `createInMemoryGrantStore` (tenantId accepted, unused).
 */
export function createInMemoryWritableGrantStore(
  initial: GrantRule[] = [],
): WritableGrantStore & { grants: GrantRule[] } {
  const grants = [...initial];
  return {
    grants,
    async collectGrants(principalId: string, _tenantId?: string) {
      const now = new Date();
      return grants.filter((g) => {
        if (g.principalId !== principalId) return false;
        if (g.expiresAt !== null && g.expiresAt <= now) return false;
        return true;
      });
    },
    async putGrant(grant: GrantRule) {
      const idx = grants.findIndex((g) => g.id === grant.id);
      if (idx >= 0) grants[idx] = grant;
      else grants.push(grant);
    },
  };
}
