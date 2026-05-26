import { describe, expect, test } from "bun:test";

import { Either } from "effect";

import {
  decodeSymphonyProperties,
  SYMPHONY_PROPERTIES_DEFAULTS,
} from "../../src/fp/symphony-properties.js";

describe("decodeSymphonyProperties", () => {
  test("returns locked defaults for an empty property bag", () => {
    const result = decodeSymphonyProperties({});

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right).toEqual(SYMPHONY_PROPERTIES_DEFAULTS);
    }
  });

  test("decodes a partial typed view, drops unknown keys silently", () => {
    const result = decodeSymphonyProperties({
      symphony_state: "active",
      symphony_ready: "true",
      symphony_attempt: "3",
      unknown_key: "should be dropped",
    });

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.symphony_state).toBe("active");
      expect(result.right.symphony_ready).toBe("true");
      expect(result.right.symphony_attempt).toBe("3");
      expect(result.right.symphony_last_error).toBeUndefined();
      expect(result.right.symphony_branch).toBeUndefined();
      // Unknown keys are dropped — only the known typed surface is exposed.
      expect("unknown_key" in result.right).toBe(false);
    }
  });

  test("returns Left on invalid symphony_state literal", () => {
    const result = decodeSymphonyProperties({ symphony_state: "wat" });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("invalid-symphony-state");
    }
  });

  test("returns Left on invalid symphony_ready literal", () => {
    const result = decodeSymphonyProperties({ symphony_ready: "yes" });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("invalid-symphony-ready");
    }
  });

  test("returns Left when text-typed property is non-string", () => {
    const result = decodeSymphonyProperties({ symphony_attempt: 7 });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("invalid-symphony-attempt");
    }
  });

  test("rejects the retired symphony_artifact property", () => {
    const result = decodeSymphonyProperties({
      symphony_artifact: "symphony/SWY-abc123",
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("forbidden-symphony-artifact");
    }
  });

  test("decodes the full symphony surface from a real-shaped property bag", () => {
    const result = decodeSymphonyProperties({
      symphony_state: "needs-attention",
      symphony_ready: "true",
      symphony_attempt: "2",
      symphony_last_error: "bundle integration failed: refs missing",
      symphony_branch: "symphony/SWY-abc123",
      symphony_pr_url: "https://github.com/fiberplane/switchyard/pull/123",
      symphony_pr_number: "123",
      symphony_base_sha: "0123456789abcdef0123456789abcdef01234567",
      symphony_head_sha: "89abcdef0123456789abcdef0123456789abcdef",
      symphony_run_id: "swy-swyrd-abc123-1",
      symphony_sandbox_id: "sb-123",
    });

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right).toEqual({
        symphony_state: "needs-attention",
        symphony_ready: "true",
        symphony_attempt: "2",
        symphony_last_error: "bundle integration failed: refs missing",
        symphony_branch: "symphony/SWY-abc123",
        symphony_pr_url: "https://github.com/fiberplane/switchyard/pull/123",
        symphony_pr_number: "123",
        symphony_base_sha: "0123456789abcdef0123456789abcdef01234567",
        symphony_head_sha: "89abcdef0123456789abcdef0123456789abcdef",
        symphony_run_id: "swy-swyrd-abc123-1",
        symphony_sandbox_id: "sb-123",
      });
    }
  });
});
