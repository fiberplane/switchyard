import { describe, expect, test } from "bun:test";

import { Effect, Either, ParseResult, Schema } from "effect";

import {
  DaytonaSessionCreateError,
  DaytonaSessionExecError,
  DaytonaSessionInputError,
  DaytonaSessionLogError,
  DaytonaSessionNotFoundError,
  DaytonaSessionOpError,
} from "../../src/daytona/errors.js";
import { DaytonaSessionExecuteResponseSchema } from "../../src/daytona/session-models.js";

describe("DaytonaSession errors", () => {
  test("DaytonaSessionCreateError tags and exposes its fields", () => {
    const error = new DaytonaSessionCreateError({
      sandboxId: "sb-1",
      reason: "create failed",
    });
    expect(error._tag).toBe("DaytonaSessionCreateError");
    expect(error.sandboxId).toBe("sb-1");
    expect(error.reason).toBe("create failed");
    expect(error.message).toContain("sb-1");
    expect(error.message).toContain("create failed");
  });

  test("DaytonaSessionExecError tags and exposes its fields", () => {
    const error = new DaytonaSessionExecError({
      sessionId: "sess-1",
      reason: "exec failed",
    });
    expect(error._tag).toBe("DaytonaSessionExecError");
    expect(error.sessionId).toBe("sess-1");
    expect(error.reason).toBe("exec failed");
  });

  test("DaytonaSessionLogError tags and exposes its fields", () => {
    const error = new DaytonaSessionLogError({
      sessionId: "sess-1",
      commandId: "cmd-1",
      reason: "ws closed",
    });
    expect(error._tag).toBe("DaytonaSessionLogError");
    expect(error.sessionId).toBe("sess-1");
    expect(error.commandId).toBe("cmd-1");
    expect(error.reason).toBe("ws closed");
  });

  test("DaytonaSessionInputError tags and exposes its fields", () => {
    const error = new DaytonaSessionInputError({
      sessionId: "sess-1",
      commandId: "cmd-1",
      reason: "send failed",
    });
    expect(error._tag).toBe("DaytonaSessionInputError");
    expect(error.sessionId).toBe("sess-1");
    expect(error.commandId).toBe("cmd-1");
  });

  test("DaytonaSessionNotFoundError tags and exposes its fields", () => {
    const error = new DaytonaSessionNotFoundError({
      sessionId: "sess-1",
      operation: "send",
      reason: "session vanished",
    });
    expect(error._tag).toBe("DaytonaSessionNotFoundError");
    expect(error.sessionId).toBe("sess-1");
    expect(error.operation).toBe("send");
  });

  test("DaytonaSessionOpError tags and exposes its fields", () => {
    const error = new DaytonaSessionOpError({
      sessionId: "sess-1",
      operation: "waitExit",
      reason: "deadline",
    });
    expect(error._tag).toBe("DaytonaSessionOpError");
    expect(error.sessionId).toBe("sess-1");
    expect(error.operation).toBe("waitExit");
  });
});

describe("DaytonaSessionExecuteResponseSchema", () => {
  test("decodes a well-formed response", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(DaytonaSessionExecuteResponseSchema)({ cmdId: "abc" }),
    );
    expect(decoded).toEqual({ cmdId: "abc" });
  });

  test("rejects an empty object with ParseError", async () => {
    const result = await Effect.runPromise(
      Effect.either(Schema.decodeUnknown(DaytonaSessionExecuteResponseSchema)({})),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
    }
  });

  test("rejects a non-string cmdId", async () => {
    const result = await Effect.runPromise(
      Effect.either(Schema.decodeUnknown(DaytonaSessionExecuteResponseSchema)({ cmdId: 42 })),
    );
    expect(Either.isLeft(result)).toBe(true);
  });
});
