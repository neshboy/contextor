import { describe, it, expect } from "vitest";
import { countTokens, countTokensSimple, heuristicTokenCount } from "../src/tokens.js";
import { SAMPLE_FILE_CONTENT } from "./fixtures/sample-content.js";

describe("countTokens", () => {
  it("returns zero tokens for empty input", () => {
    expect(countTokens("")).toEqual({ tokens: 0, method: "bpe" });
  });

  it("uses the real BPE tokenizer by default", () => {
    const result = countTokens("hello world");
    expect(result.method).toBe("bpe");
    expect(result.tokens).toBeGreaterThan(0);
  });

  it("is deterministic for identical input", () => {
    expect(countTokens(SAMPLE_FILE_CONTENT)).toEqual(countTokens(SAMPLE_FILE_CONTENT));
  });

  it("scales roughly with input size (a much larger blob costs more tokens)", () => {
    const small = countTokensSimple("a short sentence.");
    const large = countTokensSimple(SAMPLE_FILE_CONTENT);
    expect(large).toBeGreaterThan(small * 10);
  });

  it("produces a token count in the same order of magnitude as the chars/4 heuristic", () => {
    // Not exact - that's the whole point of documenting this as an
    // approximation - but a real BPE count for ordinary code/text should
    // land within a small multiple of the chars/4 rule of thumb, not be
    // wildly different (which would indicate something is broken).
    const bpe = countTokensSimple(SAMPLE_FILE_CONTENT);
    const heuristic = heuristicTokenCount(SAMPLE_FILE_CONTENT);
    expect(bpe).toBeGreaterThan(heuristic * 0.3);
    expect(bpe).toBeLessThan(heuristic * 3);
  });
});

describe("heuristicTokenCount", () => {
  it("implements the documented chars/4 formula exactly", () => {
    expect(heuristicTokenCount("12345678")).toBe(2);
    expect(heuristicTokenCount("123456789")).toBe(3); // Math.ceil(9/4) = 3
    expect(heuristicTokenCount("")).toBe(0);
  });
});

describe("countTokensSimple", () => {
  it("returns just the numeric count", () => {
    expect(countTokensSimple("hello world")).toBe(countTokens("hello world").tokens);
  });
});
