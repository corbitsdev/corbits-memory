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

/**
 * What a stored `acl_block` value turned out to be.
 *
 * `unreadable` is deliberately distinct from `absent`: a value that is present
 * but not a list of principal ids tells us an ACL was intended and that we do
 * not understand it. Callers must block on it — guessing there means guessing
 * in the direction of disclosure.
 */
export type BlockListRead =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "list"; principalIds: string[] };

/**
 * Reads a stored `acl_block` value.
 *
 * Both encodings are accepted. `capture()` writes a JSON-encoded string, but
 * `attributes` is `jsonb` and a native array is the natural shape for anything
 * writing the column directly — a seed script, a migration, another service.
 * Whether a block list is honoured must not depend on which writer produced it.
 */
export function readBlockList(raw: unknown): BlockListRead {
  if (raw === undefined || raw === null) return { kind: "absent" };

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    // A blank value is nothing rather than a list we failed to read.
    if (raw.trim() === "") return { kind: "absent" };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "unreadable" };
    }
  }

  if (!Array.isArray(parsed)) return { kind: "unreadable" };
  // Indexed rather than `every`, which skips holes in a sparse array and would
  // let `["a", , "b"]` through as string[] carrying an undefined.
  const principalIds: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry: unknown = parsed[i];
    if (typeof entry !== "string") return { kind: "unreadable" };
    principalIds.push(entry);
  }
  return { kind: "list", principalIds };
}

/**
 * Decides which of the searched documents this principal may not see.
 *
 * Takes the ids that were searched alongside the rows that came back, because
 * a document that could not be loaded must be withheld too. Resolving either
 * kind of missing information — an ACL we cannot read, or a row we cannot find
 * — in the direction of disclosure is the failure this guards against.
 */
export function blockedDocumentIds(
  documentIds: readonly string[],
  rows: readonly { id: string; attributes: Record<string, unknown> | null }[],
  principalId: string,
): { blocked: Set<string>; unreadable: string[] } {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const blocked = new Set<string>();
  const unreadable: string[] = [];

  for (const id of documentIds) {
    const row = byId.get(id);
    if (row === undefined) {
      // Searched but not loaded: deleted mid-search, or a read that raced a
      // write. We cannot evaluate its ACL, so we do not return it.
      unreadable.push(id);
      blocked.add(id);
      continue;
    }
    const read = readBlockList(row.attributes?.["acl_block"]);
    if (read.kind === "absent") continue;
    if (read.kind === "unreadable") {
      unreadable.push(id);
      blocked.add(id);
      continue;
    }
    if (read.principalIds.includes(principalId)) blocked.add(id);
  }

  return { blocked, unreadable };
}
