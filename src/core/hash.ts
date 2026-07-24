import { createHash } from "node:crypto";

// Deterministic JSON stringify: object keys sorted recursively so the same
// logical value always serializes to the same string regardless of
// insertion order. Arrays keep their order (order is meaningful there).
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// The NOOP-check key: the same logical input (title + kind + externalRef +
// attributes + chunk text) always produces the same hash, so a re-fetch that
// changed nothing never mints a new version.
export function contentHash(parts: {
  title: string;
  kind: string;
  externalRef: string;
  attributes: Record<string, string | number | boolean | null>;
  chunkTexts: readonly string[];
}): string {
  const raw = [
    parts.title,
    parts.kind,
    parts.externalRef,
    stableStringify(parts.attributes),
    parts.chunkTexts.join(""),
  ].join(" ");
  return createHash("sha256").update(raw).digest("hex");
}
