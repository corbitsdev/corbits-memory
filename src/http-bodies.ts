/**
 * Shared request bodies for hub memory HTTP and defineTool factories.
 * Keep route validators and tool arg parsers on the same schemas.
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
});

export type AddRequest = typeof AddRequest.infer;

export const SearchRequest = type({
  query: "string >= 1",
  "limit?": type(`${SEARCH_LIMIT_MIN} <= number.integer <= ${SEARCH_LIMIT_MAX}`),
  "kinds?": "string[]",
  "entity_ids?": "string[]",
  "sources?": "string[]",
  "includeEvidence?": "boolean",
});

export type SearchRequest = typeof SearchRequest.infer;

export const ListArgs = type({
  "limit?": type(`${LIST_LIMIT_MIN} <= number.integer <= ${LIST_LIMIT_MAX}`),
});

export type ListArgs = typeof ListArgs.infer;

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
