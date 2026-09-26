/**
 * Grant *requirements* for installers — not live grants.
 *
 * `package.json` → `interchange.grantRequirements` is the single source, so a
 * host installer can read npm metadata without executing code; this module
 * loads and validates it for in-process callers.
 *
 * Shape matches Interchange definition grant requirements
 * (`resource` + `action` + `installHint`). Control plane materializes grants
 * onto the workflow principal at deploy/launch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";

const GrantRequirement = type({
  resource: "string",
  action: "string",
  /**
   * Advisory-only sizing hint for install tooling deciding how broadly to
   * mint the underlying `resource`/`action` capability grant (e.g. "give
   * every tenant member `memory:search`" vs "give this principal
   * `memory:forget` scoped to what it creates"). **Nothing in this package
   * reads or enforces this value** — whether a specific caller may actually
   * forget/purge a specific document is decided entirely by the imperative
   * creator check in `services/retention-ownership.ts`. See ARCHITECTURE.md
   * § Boundaries for the two-mechanism split.
   */
  installHint: "'tenant' | 'creator' | 'invoker'",
  /** Package surfaces that need the requirement when installed. */
  surfaces: "('tools' | 'distiller' | 'routes')[]",
});

export type MemoryGrantRequirement = typeof GrantRequirement.infer;
export type MemoryGrantInstallHint = MemoryGrantRequirement["installHint"];
export type MemoryGrantSurface = MemoryGrantRequirement["surfaces"][number];

const PackageGrantRequirements = type({
  interchange: { grantRequirements: GrantRequirement.array() },
});

/**
 * Minimum capability grants for memory tools / routes / process helpers.
 * Document-tag access (`memory.doc:…`, `memory.space:…`) is separate and
 * minted per document — not package install requirements.
 *
 * `forget` and `purge` are `installHint: "creator"`: a sizing suggestion
 * only. The per-document ownership check runs in
 * `services/retention-ownership.ts` regardless of how broadly they are minted.
 */
export const MEMORY_GRANT_REQUIREMENTS: readonly MemoryGrantRequirement[] =
  PackageGrantRequirements.assert(
    JSON.parse(
      // dirname (not Bun-only `dir`): package.json sits one level above both
      // src/ and the packed dist/.
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ),
  ).interchange.grantRequirements;

/** Compact `resource:action` form used on agent `capabilities` arrays. */
export const MEMORY_CAPABILITY_IDS = MEMORY_GRANT_REQUIREMENTS.map(
  (r) => `${r.resource}:${r.action}`,
);

/**
 * Capability ids scoped to one install surface — a distiller/tools install
 * must not inherit a routes-only capability (like `forget`/`purge`) just
 * because it appears somewhere in the full requirement list.
 */
export function capabilityIdsForSurface(surface: MemoryGrantSurface): string[] {
  return MEMORY_GRANT_REQUIREMENTS.filter((r) =>
    r.surfaces.includes(surface),
  ).map((r) => `${r.resource}:${r.action}`);
}
