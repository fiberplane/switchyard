import { describe, expect, test } from "bun:test";

import { SYMPHONY_LAST_ERROR_MAX_CHARS, truncateLastError } from "../../src/orchestrator/errors.js";

describe("truncateLastError", () => {
  test("returns the only line for a single-line message", () => {
    expect(truncateLastError("simple reason")).toBe("simple reason");
  });

  test("strips multiline messages to the first non-empty line", () => {
    expect(truncateLastError("\n\nfirst real line\nsecond line\nstack trace ...")).toBe(
      "first real line",
    );
  });

  test("hard-caps the result at SYMPHONY_LAST_ERROR_MAX_CHARS with ellipsis suffix", () => {
    const long = "x".repeat(SYMPHONY_LAST_ERROR_MAX_CHARS + 50);
    const truncated = truncateLastError(long);
    expect(truncated.length).toBe(SYMPHONY_LAST_ERROR_MAX_CHARS);
    expect(truncated.endsWith("…")).toBe(true);
  });

  test("returns empty string when the input has no non-empty line", () => {
    expect(truncateLastError("\n\n\n")).toBe("");
  });
});
