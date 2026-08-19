/**
 * Grant *requirements* for installers — not live grants.
 *
 * Mirrored under `package.json` → `interchange.grantRequirements` so a
 * host installer can read npm metadata without executing code. The typed
 * export is the in-repo SSOT; keep package.json in lockstep.
 *
 * Shape matches Interchange definition grant requirements
 * (`resource` + `action` + `source`). Control plane materializes grants
 * onto the workflow principal at deploy/launch.
 */

export type MemoryGrantSource = "tenant" | "creator" | "invoker";

/** Package surfaces that need the requirement when installed. */
export type MemoryGrantSurface = "tools" | "distiller" | "routes";

export type MemoryGrantRequirement = {
  readonly resource: string;
  readonly action: string;
  /** Recommended authority source; installer/deploy may override. */
  readonly source: MemoryGrantSource;
  readonly surfaces: readonly MemoryGrantSurface[];
};

/**
 * Minimum capability grants for memory tools / routes / process helpers.
 * Document-tag access (`memory.doc:…`, `memory.space:…`) is separate and
 * minted per document — not package install requirements.
 */
export const MEMORY_GRANT_REQUIREMENTS = [
  {
    resource: "memory",
    action: "add",
    source: "tenant",
    surfaces: ["tools", "distiller", "routes"],
  },
  {
    resource: "memory",
    action: "search",
    source: "tenant",
    surfaces: ["tools", "distiller", "routes"],
  },
  /**
   * Retention writes (CL-6288). `source: "creator"` (unlike `add`/`search`'s
   * `"tenant"`) flags that this capability pairs with the document-ownership
   * check the routes also enforce — granting it authorizes *calling*
   * forget/purge, never *whose* documents it reaches. Tombstone and
   * retention-class changes share `forget`; hard delete gets its own `purge`
   * so a host can hand out "let this user forget their own notes" without
   * also handing out irreversible deletion.
   */
  {
    resource: "memory",
    action: "forget",
    source: "creator",
    surfaces: ["routes"],
  },
  {
    resource: "memory",
    action: "purge",
    source: "creator",
    surfaces: ["routes"],
  },
] as const satisfies readonly MemoryGrantRequirement[];

/** Compact `resource:action` form used on agent `capabilities` arrays. */
export const MEMORY_CAPABILITY_IDS = MEMORY_GRANT_REQUIREMENTS.map(
  (r) => `${r.resource}:${r.action}` as const,
);

/**
 * Capability ids scoped to one install surface — a distiller/tools install
 * must not inherit a routes-only capability (like `forget`/`purge`) just
 * because it appears somewhere in the full requirement list.
 */
export function capabilityIdsForSurface(
  surface: MemoryGrantSurface,
): string[] {
  return MEMORY_GRANT_REQUIREMENTS.filter((r) =>
    (r.surfaces as readonly MemoryGrantSurface[]).includes(surface),
  ).map((r) => `${r.resource}:${r.action}`);
}
