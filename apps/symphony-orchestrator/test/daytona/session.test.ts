import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { NodeContext } from "@effect/platform-node";
import { Chunk, Effect, Either, ParseResult, Schema, Stream } from "effect";

import { DaytonaAdapter, DaytonaAdapterLive } from "../../src/daytona/daytona.adapter.js";
import { DaytonaSession, DaytonaSessionLive } from "../../src/daytona/daytona.session.js";
import {
  DaytonaSessionCreateError,
  DaytonaSessionExecError,
  DaytonaSessionInputError,
  DaytonaSessionLogError,
  DaytonaSessionNotFoundError,
  DaytonaSessionOpError,
} from "../../src/daytona/errors.js";
import type { SandboxHandle } from "../../src/daytona/models.js";
import { DaytonaSessionExecuteResponseSchema } from "../../src/daytona/session-models.js";
import { buildTestSandboxSpec } from "./test-helpers/sandbox-spec.js";
import { ensureTestSnapshot } from "./test-helpers/snapshot.js";
import { daytonaTestConfig, deleteByTestRunId, ensureStackUp } from "./test-helpers/stack.js";
import { sweepOrphanedTestSandboxes } from "./test-helpers/sweep.js";

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

describe("DaytonaSession service", () => {
  test("constructs via DaytonaSessionLive Layer and exposes start", async () => {
    const program = Effect.gen(function* () {
      const session = yield* DaytonaSession;
      return typeof session.start;
    }).pipe(Effect.provide(DaytonaSessionLive(daytonaTestConfig)));

    const result = await Effect.runPromise(program);
    expect(result).toBe("function");
  });
});

describe("DaytonaSession round-trip", () => {
  const testRunId = crypto.randomUUID();
  let sharedHandle: SandboxHandle;

  const runWithSession = <A, E>(effect: Effect.Effect<A, E, DaytonaSession>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(DaytonaSessionLive(daytonaTestConfig)),
        Effect.provide(NodeContext.layer),
      ),
    );

  const runWithAdapter = <A, E>(effect: Effect.Effect<A, E, DaytonaAdapter>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(DaytonaAdapterLive(daytonaTestConfig)),
        Effect.provide(NodeContext.layer),
      ),
    );

  beforeAll(async () => {
    await ensureStackUp();
    await sweepOrphanedTestSandboxes();
    await ensureTestSnapshot();

    sharedHandle = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* DaytonaAdapter;
        return yield* adapter.createSandbox(buildTestSandboxSpec({ testRunId }));
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await deleteByTestRunId(testRunId);
  }, 180_000);

  test("start returns a ProtocolStream with non-empty sessionId and commandId", async () => {
    const result = await runWithSession(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* DaytonaSession;
          const stream = yield* session.start(sharedHandle, "echo ready; sleep 1; echo done");
          return { sessionId: stream.sessionId, commandId: stream.commandId };
        }),
      ),
    );

    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.commandId.length).toBeGreaterThan(0);
  }, 60_000);

  const echoLoopFixturePath = fileURLToPath(
    new URL("./fixtures/bash-echo-loop.sh", import.meta.url),
  );
  const remoteEchoLoopPath = "/tmp/bash-echo-loop.sh";
  const peerCommand = `bash ${remoteEchoLoopPath}`;
  let echoLoopUploaded = false;
  const ensureEchoLoopUploaded = async (): Promise<void> => {
    if (echoLoopUploaded) {
      return;
    }
    await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* DaytonaAdapter;
        yield* adapter.uploadFiles(sharedHandle, [
          { src: echoLoopFixturePath, dst: remoteEchoLoopPath },
        ]);
      }),
    );
    echoLoopUploaded = true;
  };

  test("receive stream emits stdout chunks in order", async () => {
    const chunks = await runWithSession(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* DaytonaSession;
          const stream = yield* session.start(sharedHandle, "printf 'line-1\\nline-2\\n'");
          const collected = yield* Stream.runCollect(stream.receive).pipe(
            Effect.timeoutFail({
              duration: "5 seconds",
              onTimeout: () =>
                new DaytonaSessionLogError({
                  sessionId: stream.sessionId,
                  commandId: stream.commandId,
                  reason: "receive deadline exceeded",
                }),
            }),
          );
          return Chunk.toReadonlyArray(collected);
        }),
      ),
    );

    const concatenated = chunks.join("");
    const idxLine1 = concatenated.indexOf("line-1");
    const idxLine2 = concatenated.indexOf("line-2");
    expect(idxLine1).toBeGreaterThanOrEqual(0);
    expect(idxLine2).toBeGreaterThan(idxLine1);
  }, 60_000);

  test("send/receive round-trip with unicode and shell-special probes", async () => {
    await ensureEchoLoopUploaded();

    const probes = [
      "msg-1-plain",
      "msg-2-numbers-12345",
      "msg-3-with-spaces and unicode α β γ",
      "msg-4-binary-ish: \"quotes\" 'apos' $dollar `tick` \\back",
    ];

    const observed = await runWithSession(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* DaytonaSession;
          const stream = yield* session.start(sharedHandle, peerCommand);

          // Drive the receive stream into a buffer in a forked fiber so the
          // test body can poll for echoes without consuming the stream.
          const receivedChunks: string[] = [];
          yield* Effect.forkScoped(
            stream.receive.pipe(
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  receivedChunks.push(chunk);
                }),
              ),
              Stream.runDrain,
              Effect.ignore,
            ),
          );

          const waitFor = (predicate: () => boolean, deadlineMs: number) =>
            Effect.gen(function* () {
              const start = Date.now();
              while (!predicate() && Date.now() - start < deadlineMs) {
                yield* Effect.sleep("50 millis");
              }
              return predicate();
            });

          // Wait for the bash loop to print "ready".
          const ready = yield* waitFor(() => receivedChunks.join("").includes("ready"), 10_000);
          expect(ready).toBe(true);

          for (const probe of probes) {
            const before = receivedChunks.join("");
            yield* stream.send(`${probe}\n`);
            const expected = `echo:${probe}`;
            const arrived = yield* waitFor(
              () => receivedChunks.join("").slice(before.length).includes(expected),
              5_000,
            );
            expect(arrived).toBe(true);
          }

          // Sentinel exit so the bash loop terminates and the stream closes.
          yield* stream.send("__EXIT__\n");

          return receivedChunks.join("");
        }),
      ),
    );

    for (const probe of probes) {
      const expected = `echo:${probe}`;
      expect(observed).toContain(expected);
    }
  }, 90_000);

  test("stderr stream demuxes from stdout", async () => {
    const result = await runWithSession(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* DaytonaSession;
          const stream = yield* session.start(
            sharedHandle,
            "echo first; echo second 1>&2; echo third",
          );

          const stdoutF = yield* Effect.fork(
            Stream.runCollect(stream.receive).pipe(Effect.timeoutOption("5 seconds")),
          );
          const stderrF = yield* Effect.fork(
            Stream.runCollect(stream.stderr).pipe(Effect.timeoutOption("5 seconds")),
          );

          const stdoutChunks = yield* stdoutF;
          const stderrChunks = yield* stderrF;

          return {
            stdout: Chunk.toReadonlyArray(
              stdoutChunks._tag === "Some" ? stdoutChunks.value : Chunk.empty<string>(),
            ).join(""),
            stderr: Chunk.toReadonlyArray(
              stderrChunks._tag === "Some" ? stderrChunks.value : Chunk.empty<string>(),
            ).join(""),
          };
        }),
      ),
    );

    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("third");
    expect(result.stdout).not.toContain("second");
    expect(result.stderr).toContain("second");
    expect(result.stderr).not.toContain("first");
    expect(result.stderr).not.toContain("third");
  }, 60_000);
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
