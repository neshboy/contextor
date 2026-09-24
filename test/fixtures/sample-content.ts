/** A deterministic, ~5.6KB blob standing in for "a file the agent read", shared across tests. */
export const SAMPLE_FILE_CONTENT = "export function add(a: number, b: number): number {\n  return a + b;\n}\n".repeat(
  80,
);

/** A second, distinct deterministic blob, used to prove different content is never confused with SAMPLE_FILE_CONTENT. */
export const OTHER_FILE_CONTENT = "export function subtract(a: number, b: number): number {\n  return a - b;\n}\n".repeat(
  80,
);
