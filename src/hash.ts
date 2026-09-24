import { createHash } from "node:crypto";

export interface NormalizeOptions {
  /**
   * When true, collapses runs of whitespace and trims before hashing, so
   * content that differs only in incidental whitespace (re-pasted with
   * different trailing newlines, different indentation-only diffs, etc.)
   * still hashes identically. This is Contextor's "near-duplicate" mode: a
   * real, simple, fully deterministic normalization — not a fuzzy or
   * probabilistic similarity match.
   */
  normalizeWhitespace: boolean;
}

/** Real byte-identical hash of a string (SHA-256, hex-encoded). */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Applies the configured normalization before hashing. See {@link NormalizeOptions}. */
export function normalizeForHash(text: string, opts: NormalizeOptions): string {
  if (!opts.normalizeWhitespace) return text;
  return text.replace(/\s+/g, " ").trim();
}

/** Computes the dedup-comparison hash for a block of text under the given options. */
export function contentHash(text: string, opts: NormalizeOptions): string {
  return hashText(normalizeForHash(text, opts));
}

/** UTF-8 byte length of a string, used for size accounting in the transparency log. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
