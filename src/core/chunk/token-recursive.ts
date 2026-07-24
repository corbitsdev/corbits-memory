import { DEFAULT_CHUNK_CAPS, type ChunkCaps, type TokenChunk } from "./types.ts";

// Separator ladder tried in order before falling back to a hard character
// cut. Word/whitespace-based token counting
// (char count / 4) is an approximation acceptable for W0 — no BPE tokenizer;
// a future CJK-aware pass (edge case K06) replaces this with a real one.
const SEPARATORS = ["\n\n", "\n", ". ", " "] as const;
const CHARS_PER_TOKEN = 4;

function approxTokens(charLength: number): number {
  return Math.max(1, Math.ceil(charLength / CHARS_PER_TOKEN));
}

// Splits `text` on every occurrence of `sep`, keeping `sep` attached to the
// end of the piece that precedes it — so `pieces.join("")` reconstructs the
// original string exactly (offsets stay computable from piece lengths).
function splitKeepingSeparator(text: string, sep: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split(sep);
  const pieces: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    const isLast = i === parts.length - 1;
    const piece = isLast ? part : part + sep;
    if (piece.length > 0) pieces.push(piece);
  }
  return pieces;
}

type Leaf = { text: string; start: number; end: number };

// Recursively splits `text` down the separator ladder until every leaf fits
// within `maxChars`; a leaf that still doesn't fit after the last separator
// gets a hard character cut. `offset` tracks the leaf's absolute position in
// the original document for citation spans.
function splitRecursive(
  text: string,
  offset: number,
  maxChars: number,
  sepIndex: number,
): Leaf[] {
  if (text.length === 0) return [];
  if (text.length <= maxChars) {
    return [{ text, start: offset, end: offset + text.length }];
  }
  if (sepIndex >= SEPARATORS.length) {
    const leaves: Leaf[] = [];
    let pos = 0;
    while (pos < text.length) {
      const end = Math.min(pos + maxChars, text.length);
      leaves.push({
        text: text.slice(pos, end),
        start: offset + pos,
        end: offset + end,
      });
      pos = end;
    }
    return leaves;
  }
  const sep = SEPARATORS[sepIndex];
  if (sep === undefined) {
    throw new Error("splitRecursive: sepIndex out of range");
  }
  const pieces = splitKeepingSeparator(text, sep);
  const leaves: Leaf[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    leaves.push(
      ...splitRecursive(piece, offset + cursor, maxChars, sepIndex + 1),
    );
    cursor += piece.length;
  }
  return leaves;
}

// Greedily accumulates leaves into chunks capped at `maxChars`; when a chunk
// is closed, the tail of its leaves (up to `overlapChars` worth) seeds the
// next chunk, so consecutive chunks physically share boundary text. Only this
// token-split strategy carries overlap (edge case K07 — structure-aware
// strategies elsewhere must not inherit a bogus overlap).
function mergeLeaves(
  leaves: Leaf[],
  maxChars: number,
  overlapChars: number,
): Leaf[][] {
  const groups: Leaf[][] = [];
  let current: Leaf[] = [];
  let currentLen = 0;
  for (const leaf of leaves) {
    if (currentLen + leaf.text.length > maxChars && current.length > 0) {
      groups.push([...current]);
      while (current.length > 0 && currentLen > overlapChars) {
        const removed = current.shift();
        if (!removed) break;
        currentLen -= removed.text.length;
      }
    }
    current.push(leaf);
    currentLen += leaf.text.length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// A trailing chunk under `minChars` is never emitted as its own stub — it is
// merged into the previous chunk instead (this is the fallback strategy, so
// there is no title/action-item role exemption to consider here).
function mergeRemnant(groups: Leaf[][], minChars: number): Leaf[][] {
  if (groups.length < 2) return groups;
  const last = groups[groups.length - 1] ?? [];
  const secondToLast = groups[groups.length - 2] ?? [];
  const lastLen = last.reduce((sum, leaf) => sum + leaf.text.length, 0);
  if (lastLen >= minChars) return groups;
  return [...groups.slice(0, -2), [...secondToLast, ...last]];
}

/**
 * Baseline token-recursive chunker — the fallback strategy every adapter can
 * rely on. Pure, synchronous, no I/O. Token counting is an approximation
 * (character count / 4) — see the SEPARATORS comment above.
 */
export function chunkTokenRecursive(
  text: string,
  caps: Partial<ChunkCaps> = {},
): TokenChunk[] {
  if (text.length === 0) return [];
  const resolved: ChunkCaps = { ...DEFAULT_CHUNK_CAPS, ...caps };
  const maxChars = resolved.maxTokens * CHARS_PER_TOKEN;
  const minChars = resolved.minTokens * CHARS_PER_TOKEN;
  const overlapChars = resolved.overlapTokens * CHARS_PER_TOKEN;

  const leaves = splitRecursive(text, 0, maxChars, 0);
  const merged = mergeRemnant(mergeLeaves(leaves, maxChars, overlapChars), minChars);

  return merged.map((group, ordinal) => {
    const chunkText = group.map((leaf) => leaf.text).join("");
    const first = group[0] ?? { text: "", start: 0, end: 0 };
    const last = group[group.length - 1] ?? first;
    return {
      ordinal,
      text: chunkText,
      tokenCount: approxTokens(chunkText.length),
      span: { start: first.start, end: last.end },
      metadata: { strategy: "token.recursive" as const },
    };
  });
}
