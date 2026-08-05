import { createHash } from "node:crypto";

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

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** NOOP key for AdaptedDocument — same logical content → same hash. */
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
