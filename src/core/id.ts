const BASE62_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generates a typed, prefixed id: `${prefix}_${22-char base62 string}`. The
 * random suffix is drawn from `crypto.getRandomValues` (no external dep,
 * available in Bun/browser/Node via the global `crypto`).
 */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(22);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (let i = 0; i < bytes.length; i++) {
    suffix += BASE62_ALPHABET[(bytes[i] as number) % BASE62_ALPHABET.length];
  }
  return `${prefix}_${suffix}`;
}
