/**
 * Shared request bodies for hub memory HTTP and defineTool factories.
 * Keep route validators and tool arg parsers on the same schemas.
 *
 * GET list uses a string query param on the wire (`ListQuery`); tools use
 * numeric `ListArgs`. Bounds are shared via `limits.ts` and `parseListLimitString`.
 */
import { type } from "arktype";

import {
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  SEARCH_LIMIT_MAX,
  SEARCH_LIMIT_MIN,
} from "./limits.ts";

export const ShareBody = type({
  "tenant?": "boolean",
  "principals?": "string[]",
  "tags?": "string[]",
});

export const AddRequest = type({
  title: "string >= 1",
  text: "string >= 1",
  "access_tags?": "string[]",
  "share?": ShareBody,
  "kind?": "string",
  /** Distiller / agent identity on the written version (loop-safety + attribution). */
  "generator_agent_id?": "string >= 1",
  "provenance?": "'stated'|'inferred'|'unknown'",
  "lineage_class?": "'native'|'imported'|'derived'",
  "temporal_class?": "'event'|'deadline'|'state'|'lesson'",
  /** Source version ids this claim is derived from (minted as derived_from edges). */
  "derived_from?": "string[]",
  "valid_from?": "string",
  "valid_until?": "string",
});

export type AddRequest = typeof AddRequest.infer;

export const SearchRequest = type({
  query: "string >= 1",
  "limit?": type(`${SEARCH_LIMIT_MIN} <= number.integer <= ${SEARCH_LIMIT_MAX}`),
  "kinds?": "string[]",
  "entity_ids?": "string[]",
  "sources?": "string[]",
  "includeEvidence?": "boolean",
  "includeDeprecated?": "boolean",
});

export type SearchRequest = typeof SearchRequest.infer;

/** HTTP query schema for GET /memory/list (string limit from the URL). */
export const ListQuery = type({
  "limit?": "string",
});

export type ListQuery = typeof ListQuery.infer;

/** Tool-arg shape for memory_list (numeric limit after LLM coerce). */
export const ListArgs = type({
  "limit?": type(`${LIST_LIMIT_MIN} <= number.integer <= ${LIST_LIMIT_MAX}`),
});

export type ListArgs = typeof ListArgs.infer;

/**
 * Parse a list `limit` query string into a bounded integer.
 * Returns `undefined` for missing/empty; `null` for invalid/out-of-range.
 */
export function parseListLimitString(
  raw: string | undefined,
): number | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (
    !Number.isInteger(n) ||
    n < LIST_LIMIT_MIN ||
    n > LIST_LIMIT_MAX
  ) {
    return null;
  }
  return n;
}

/** HTTP query schema for GET /memory/feed. */
export const FeedQuery = type({
  "after?": "string",
  "limit?": "string",
  "exclude_generator?": "string",
});

export type FeedQuery = typeof FeedQuery.infer;

export type ParsedFeedQuery = {
  after?: number;
  limit?: number;
  excludeGenerator?: string;
};

/**
 * Parse feed query params. Returns `{ ok: false, error }` on invalid numbers.
 */
export function parseFeedQuery(
  q: FeedQuery,
): { ok: true; value: ParsedFeedQuery } | { ok: false; error: string } {
  const value: ParsedFeedQuery = {};
  if (q.after !== undefined && q.after !== "") {
    const n = Number(q.after);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: "after must be a non-negative integer" };
    }
    value.after = n;
  }
  if (q.limit !== undefined && q.limit !== "") {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return { ok: false, error: "limit must be an integer from 1 to 100" };
    }
    value.limit = n;
  }
  if (q.exclude_generator !== undefined && q.exclude_generator !== "") {
    value.excludeGenerator = q.exclude_generator;
  }
  return { ok: true, value };
}

/** Coerce LLM-stringified integers before arktype number.integer checks. */
export function coerceOptionalLimitArg(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const raw = args["limit"];
  if (raw === undefined || typeof raw === "number") return args;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return { ...args, limit: n };
    }
  }
  return args;
}

export function parseWithArk<T>(
  schema: (data: unknown) => T | type.errors,
  data: unknown,
  label: string,
): T {
  const parsed = schema(data);
  if (parsed instanceof type.errors) {
    throw new Error(`${label}: ${parsed.summary}`);
  }
  return parsed;
}

/** Path param for the two document-scoped retention routes (forget/purge). */
export const DocumentIdParam = type({
  documentId: "string >= 1",
});

export type DocumentIdParam = typeof DocumentIdParam.infer;

/** Path param for the version-scoped retention-class route. */
export const VersionIdParam = type({
  versionId: "string >= 1",
});

export type VersionIdParam = typeof VersionIdParam.infer;

/** POST body for `.../forget` (tombstone) — reason is audit-only, never required. */
export const ForgetRequest = type({
  "reason?": "string",
});

export type ForgetRequest = typeof ForgetRequest.infer;

/** POST body for `.../retention-class`. Kept in lockstep with RETENTION_CLASSES (core/enums.ts). */
export const SetRetentionClassRequest = type({
  retention_class: "'durable'|'standard'|'ephemeral'|'source_only'",
});

export type SetRetentionClassRequest = typeof SetRetentionClassRequest.infer;
