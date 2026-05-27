import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { DaytonaSession, DaytonaSessionLive } from "../../src/daytona/daytona.session.js";
import {
  DaytonaSessionCreateError,
  DaytonaSessionExecError,
  DaytonaSessionInputError,
  DaytonaSessionLogError,
  DaytonaSessionNotFoundError,
  DaytonaSessionOpError,
} from "../../src/daytona/errors.js";

describe("DaytonaSession errors", () => {
  test("carry stable tags and human-readable fields", () => {
    const errors = [
      new DaytonaSessionCreateError({ sandboxId: "sb-1", reason: "no runner" }),
      new DaytonaSessionExecError({ sessionId: "sess-1", reason: "bad command" }),
      new DaytonaSessionInputError({
        sessionId: "sess-1",
        commandId: "cmd-1",
        reason: "pipe closed",
      }),
      new DaytonaSessionLogError({
        sessionId: "sess-1",
        commandId: "cmd-1",
        reason: "stream closed",
      }),
      new DaytonaSessionNotFoundError({
        sessionId: "sess-1",
        operation: "send",
        reason: "missing",
      }),
      new DaytonaSessionOpError({
        sessionId: "sess-1",
        operation: "pollExit",
        reason: "sdk failure",
      }),
    ];

    expect(errors.map((error) => error._tag)).toEqual([
      "DaytonaSessionCreateError",
      "DaytonaSessionExecError",
      "DaytonaSessionInputError",
      "DaytonaSessionLogError",
      "DaytonaSessionNotFoundError",
      "DaytonaSessionOpError",
    ]);
    expect(errors.map((error) => error.message)).toEqual([
      "Daytona session create against sandbox sb-1 failed: no runner",
      "Daytona session sess-1 executeSessionCommand failed: bad command",
      "Daytona session sess-1 command cmd-1 sendSessionCommandInput failed: pipe closed",
      "Daytona session sess-1 command cmd-1 log stream failed: stream closed",
      "Daytona session sess-1 was not found during send: missing",
      "Daytona session sess-1 operation pollExit failed: sdk failure",
    ]);
  });
});

describe("DaytonaSessionLive", () => {
  test("constructs without probing the remote API", async () => {
    const program = Effect.gen(function* () {
      const session = yield* DaytonaSession;
      return typeof session.start;
    }).pipe(
      Effect.provide(
        DaytonaSessionLive({
          apiKey: "switchyard-test-api-key",
          snapshotName: "switchyard-codex-bun-test",
        }),
      ),
    );

    await expect(Effect.runPromise(program)).resolves.toBe("function");
  });
});
