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
  function collect(principalId: string) {
    const now = new Date();
    return grants.filter((g) => {
      if (g.principalId !== principalId) return false;
      if (g.expiresAt !== null && g.expiresAt <= now) return false;
      return true;
    });
  }
  // Bound to a const rather than returned as a fresh object literal: some
  // `@intx/authz` versions require `collectGrantsInChain` on `GrantStore`
  // (an ancestor-chain walk) that this package's own pinned version
  // predates. Routing through a named variable gets normal structural
  // assignment for the function's declared return type instead of
  // TypeScript's excess-property check on literals, so this satisfies
  // either shape — tenantId (and thus the ancestor chain) is a no-op here
  // regardless, matching `createInMemoryGrantStore`'s own tenant-scoped
  // fixture semantics.
  const store = {
    grants,
    async collectGrants(principalId: string, _tenantId?: string) {
      return collect(principalId);
    },
    async collectGrantsInChain(principalId: string, _tenantId?: string) {
      return collect(principalId);
    },
    async putGrant(grant: GrantRule) {
      const idx = grants.findIndex((g) => g.id === grant.id);
      if (idx >= 0) grants[idx] = grant;
      else grants.push(grant);
    },
  };
  return store;
}
