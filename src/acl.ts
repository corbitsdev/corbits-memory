/**
 * Product document ACL → engine VisibilitySpec.
 *
 * Product modes (PRODUCT.md):
 *   scope     — whole team (engine: tenant)
 *   private   — subject only (engine: private)
 *   allowlist — named principals (engine: principals)
 *
 * allow/block may be flat string[] or { subjects?: string[] } (PRODUCT.md shape).
 * groups/grants on ACL are rejected until membership resolution lands — do not
 * silently drop them (that would look like they applied).
 * Block is stored on the document and applied as a search post-filter.
 */
import type { VisibilitySpec } from "./core/schemas/document.ts";

export type AclMode = "scope" | "private" | "allowlist";

export type AclParseResult =
  | { ok: true; visibility: VisibilitySpec; block: string[] }
  | { ok: false; error: string };

function rejectUnsupportedAclFields(
  raw: unknown,
  field: string,
): string | null {
  if (raw === undefined || raw === null || Array.isArray(raw)) return null;
  if (typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.groups !== undefined) {
    return `${field}.groups is not supported yet; list subjects only, or omit groups`;
  }
  if (o.grants !== undefined) {
    return `${field}.grants is not supported yet; list subjects only, or omit grants`;
  }
  return null;
}

function subjectList(raw: unknown, field: string): string[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    if (!raw.every((x) => typeof x === "string")) {
      return { error: `${field} must be an array of strings` };
    }
    return raw as string[];
  }
  if (typeof raw === "object") {
    const unsupported = rejectUnsupportedAclFields(raw, field);
    if (unsupported) return { error: unsupported };
    const o = raw as Record<string, unknown>;
    const subjects = o.subjects;
    if (subjects === undefined) return [];
    if (!Array.isArray(subjects) || !subjects.every((x) => typeof x === "string")) {
      return { error: `${field}.subjects must be an array of strings` };
    }
    return subjects as string[];
  }
  return { error: `${field} must be an array or { subjects?: string[] }` };
}

export function parseAcl(
  raw: unknown,
  subjectId: string,
): AclParseResult {
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      visibility: { mode: "tenant" },
      block: [],
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "acl must be an object" };
  }
  const body = raw as Record<string, unknown>;
  const mode = body.mode;
  if (
    mode !== "scope" &&
    mode !== "private" &&
    mode !== "allowlist" &&
    mode !== "tenant"
  ) {
    return {
      ok: false,
      error: "acl.mode must be scope, tenant, private, or allowlist",
    };
  }

  const blockParsed = subjectList(body.block, "acl.block");
  if ("error" in blockParsed) return { ok: false, error: blockParsed.error };
  const block = blockParsed;

  if (mode === "scope" || mode === "tenant") {
    return { ok: true, visibility: { mode: "tenant" }, block };
  }

  if (mode === "private") {
    return {
      ok: true,
      visibility: { mode: "private", principalIds: [subjectId] },
      block,
    };
  }

  const allowParsed = subjectList(body.allow, "acl.allow");
  if ("error" in allowParsed) return { ok: false, error: allowParsed.error };
  const principalIds = Array.from(new Set([subjectId, ...allowParsed]));
  return {
    ok: true,
    visibility: { mode: "principals", principalIds },
    block,
  };
}
