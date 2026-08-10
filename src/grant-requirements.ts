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
] as const satisfies readonly MemoryGrantRequirement[];

/** Compact `resource:action` form used on agent `capabilities` arrays. */
export const MEMORY_CAPABILITY_IDS = MEMORY_GRANT_REQUIREMENTS.map(
  (r) => `${r.resource}:${r.action}` as const,
);
