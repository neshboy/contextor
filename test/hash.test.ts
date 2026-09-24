import { describe, it, expect } from "vitest";
import { hashText, normalizeForHash, contentHash, byteLength } from "../src/hash.js";
import { SAMPLE_FILE_CONTENT, OTHER_FILE_CONTENT } from "./fixtures/sample-content.js";

describe("hashText", () => {
  it("is deterministic for identical input", () => {
    expect(hashText(SAMPLE_FILE_CONTENT)).toBe(hashText(SAMPLE_FILE_CONTENT));
  });

  it("produces a 64-char hex SHA-256 digest", () => {
    expect(hashText("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for byte-different input, even a single trailing space", () => {
    expect(hashText(SAMPLE_FILE_CONTENT)).not.toBe(hashText(SAMPLE_FILE_CONTENT + " "));
  });

  it("differs for genuinely different content", () => {
    expect(hashText(SAMPLE_FILE_CONTENT)).not.toBe(hashText(OTHER_FILE_CONTENT));
  });
});

describe("normalizeForHash", () => {
  it("leaves text untouched when normalizeWhitespace is off", () => {
    const text = "foo   bar\n\nbaz";
    expect(normalizeForHash(text, { normalizeWhitespace: false })).toBe(text);
  });

  it("collapses whitespace runs and trims when normalizeWhitespace is on", () => {
    const text = "  foo   bar\n\nbaz  ";
    expect(normalizeForHash(text, { normalizeWhitespace: true })).toBe("foo bar baz");
  });
});

describe("contentHash", () => {
  it("treats whitespace-only variants as byte-different by default (exact mode)", () => {
    const a = "line one\nline two\n";
    const b = "line one\n\nline two\n"; // one extra blank line
    const opts = { normalizeWhitespace: false };
    expect(contentHash(a, opts)).not.toBe(contentHash(b, opts));
  });

  it("treats whitespace-only variants as the same content in near-duplicate mode", () => {
    const a = "line one\nline two\n";
    const b = "line   one\n\nline two   \n";
    const opts = { normalizeWhitespace: true };
    expect(contentHash(a, opts)).toBe(contentHash(b, opts));
  });

  it("still distinguishes genuinely different content in near-duplicate mode", () => {
    const opts = { normalizeWhitespace: true };
    expect(contentHash(SAMPLE_FILE_CONTENT, opts)).not.toBe(contentHash(OTHER_FILE_CONTENT, opts));
  });
});

describe("byteLength", () => {
  it("counts ASCII text as one byte per character", () => {
    expect(byteLength("hello")).toBe(5);
  });

  it("counts multi-byte UTF-8 characters correctly", () => {
    expect(byteLength("café")).toBe(5); // 'é' is 2 bytes in UTF-8
  });
});
