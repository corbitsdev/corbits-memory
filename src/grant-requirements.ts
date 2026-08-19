/**
 * Grant *requirements* for installers — not live grants.
 *
 * Mirrored under `package.json` → `interchange.grantRequirements` so a
 * host installer can read npm metadata without executing code. The typed
 * export is the in-repo SSOT; keep package.json in lockstep.
 *
 * Shape matches Interchange definition grant requirements
 * (`resource` + `action` + `installHint`). Control plane materializes grants
 * onto the workflow principal at deploy/launch.
 */

/**
 * Advisory-only sizing hint for install tooling deciding how broadly to mint
 * the underlying `resource`/`action` capability grant (e.g. "give every
 * tenant member `memory:search`" vs "give this principal `memory:forget`
 * scoped to what it creates"). **Nothing in this package reads or enforces
 * this value** — it is not a `requireGrant`/`canAccessDocument` mode switch,
 * and it does not gate anything at request time. Whether a specific caller
 * may actually forget/purge a specific document is decided entirely by the
 * imperative creator check in `services/retention-ownership.ts` (wired into
 * `memory.ts`), independent of grant tags and of this field. See
 * ARCHITECTURE.md § Boundaries for the two-mechanism split.
 */
export type MemoryGrantInstallHint = "tenant" | "creator" | "invoker";

/** Package surfaces that need the requirement when installed. */
export type MemoryGrantSurface = "tools" | "distiller" | "routes";

export type MemoryGrantRequirement = {
  readonly resource: string;
  readonly action: string;
  /** Install-sizing hint only — see `MemoryGrantInstallHint`. Not enforced. */
  readonly installHint: MemoryGrantInstallHint;
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
    installHint: "tenant",
    surfaces: ["tools", "distiller", "routes"],
  },
  {
    resource: "memory",
    action: "search",
    installHint: "tenant",
    surfaces: ["tools", "distiller", "routes"],
  },
  /**
   * Retention writes (CL-6288). Tombstone and retention-class changes share
   * `forget`; hard delete gets its own `purge` so a host can hand out "let
   * this user forget their own notes" without also handing out irreversible
   * deletion. `installHint: "creator"` is a sizing suggestion for install
   * tooling ONLY — the real per-document ownership check that stops a
   * caller from forgetting/purging someone else's document runs in
   * `services/retention-ownership.ts` regardless of how broadly this grant
   * was minted.
   */
  {
    resource: "memory",
    action: "forget",
    installHint: "creator",
    surfaces: ["routes"],
  },
  {
    resource: "memory",
    action: "purge",
    installHint: "creator",
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
