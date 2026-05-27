import { describe, expect, it } from "bun:test";

import { Cause, Effect, Exit, Queue, Stream } from "effect";

import {
  ProtocolSendError,
  RunnerRequestError,
  RunnerSessionClosedError,
  RunnerTurnCancelledError,
  RunnerTurnFailedError,
  RunnerTurnInputRequiredError,
  RunnerTurnTimeoutError,
} from "../../src/runner/errors.js";
import type { v2 } from "../../src/runner/protocol/index.js";
import { makeSession } from "../../src/runner/session.js";
import { encodeMessage, type ProtocolStream } from "../../src/runner/transport.js";
import { startTurn } from "../../src/runner/turn.js";

const decoder = new TextDecoder();

const initializeResponse = {
  id: 1,
  result: {
    userAgent: "switchyard-test/0.1",
    codexHome: "/tmp/codex-home",
    platformFamily: "unix",
    platformOs: "linux",
  },
};

const threadStartResponse = {
  id: 2,
  result: {
    thread: {
      id: "thread-123",
      forkedFromId: null,
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/work/repo",
      cliVersion: "0.128.0",
      source: "vscode",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.5",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/work/repo",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    reasoningEffort: null,
  } satisfies v2.ThreadStartResponse,
};

type ScriptedStream = {
  readonly stream: ProtocolStream;
  readonly sent: ReadonlyArray<Uint8Array>;
};

const makeScriptedStream = (
  onTurnStart: (
    queue: Queue.Queue<Uint8Array>,
    message: Record<string, unknown>,
  ) => Effect.Effect<void>,
  onSend?: (
    message: Record<string, unknown>,
    queue: Queue.Queue<Uint8Array>,
  ) => Effect.Effect<void, ProtocolSendError>,
): Effect.Effect<ScriptedStream> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Uint8Array>();
    const sent: Uint8Array[] = [];
    const stream: ProtocolStream = {
      send: (bytes) =>
        Effect.gen(function* () {
          sent.push(bytes);
          const message = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
          if (onSend !== undefined) {
            yield* onSend(message, queue);
          }
          if (message.method === "initialize") {
            yield* Queue.offer(queue, encodeMessage(initializeResponse));
          }
          if (message.method === "thread/start") {
            yield* Queue.offer(queue, encodeMessage(threadStartResponse));
          }
          if (message.method === "turn/start") {
            yield* onTurnStart(queue, message);
          }
        }),
      receive: Stream.fromQueue(queue),
    };
    return { stream, sent };
  });

const sentMessages = (sent: ReadonlyArray<Uint8Array>): ReadonlyArray<Record<string, unknown>> =>
  sent.map((bytes) => JSON.parse(decoder.decode(bytes)) as Record<string, unknown>);

const completedNotification = {
  method: "turn/completed",
  params: {
    threadId: "thread-123",
    turn: {
      id: "turn-1",
      items: [],
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
    },
  },
};

describe("startTurn", () => {
  it("sends turn/start with prompt, cwd, threadId, approvalPolicy, and dangerFullAccess sandboxPolicy", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(queue, encodeMessage(completedNotification));
        }),
      ),
    );

    const completed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          return yield* turn.completed;
        }),
      ),
    );

    expect(completed).toMatchObject({ threadId: "thread-123" });
    const turnStart = sentMessages(helper.sent).find((message) => message.method === "turn/start");
    expect(turnStart).toMatchObject({
      id: 3,
      method: "turn/start",
      params: {
        threadId: "thread-123",
        cwd: "/work/repo",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        input: [{ type: "text", text: "hello" }],
      },
    });
  });

  it("exposes observed notifications on the event stream", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(
            queue,
            encodeMessage({ method: "item/started", params: { threadId: "thread-123" } }),
          );
          yield* Queue.offer(queue, encodeMessage(completedNotification));
        }),
      ),
    );

    const methods = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          return yield* Stream.runCollect(
            turn.events.pipe(
              Stream.take(2),
              Stream.map((e) => e.method),
            ),
          );
        }),
      ),
    );

    expect(Array.from(methods)).toEqual(["item/started", "turn/completed"]);
  });

  it("captures notifications emitted before the turn/start response", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(
            queue,
            encodeMessage({ method: "turn/started", params: { threadId: "thread-123" } }),
          );
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(queue, encodeMessage(completedNotification));
        }),
      ),
    );

    const methods = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          yield* turn.completed;
          return yield* Stream.runCollect(turn.events);
        }),
      ),
    );

    expect(Array.from(methods).map((event) => event.method)).toEqual([
      "turn/started",
      "turn/completed",
    ]);
  });

  it("ignores terminal notifications from unrelated threads", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(
            queue,
            encodeMessage({
              method: "turn/completed",
              params: {
                threadId: "review-thread",
                turn: {
                  id: "review-turn",
                  items: [],
                  status: "completed",
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  durationMs: 1_000,
                },
              },
            }),
          );
          yield* Queue.offer(queue, encodeMessage(completedNotification));
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          const completed = yield* turn.completed;
          const events = yield* Stream.runCollect(turn.events);
          return { completed, events: Array.from(events) };
        }),
      ),
    );

    expect(result.completed).toMatchObject({ threadId: "thread-123" });
    expect(result.events.map((event) => event.params)).toEqual([
      {
        threadId: "review-thread",
        turn: {
          id: "review-turn",
          items: [],
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1_000,
        },
      },
      completedNotification.params,
    ]);
  });

  it("ends the event stream after the terminal notification", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(queue, encodeMessage(completedNotification));
        }),
      ),
    );

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          yield* turn.completed;
          return yield* Stream.runCollect(turn.events);
        }),
      ),
    );

    expect(Array.from(events).map((event) => event.method)).toEqual(["turn/completed"]);
  });

  it("auto-approves v2 command approval requests with decision accept", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(
            queue,
            encodeMessage({
              id: 0,
              method: "item/commandExecution/requestApproval",
              params: { availableDecisions: ["accept", "cancel"] },
            }),
          );
          yield* Queue.offer(queue, encodeMessage(completedNotification));
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          yield* turn.completed;
        }),
      ),
    );

    expect(sentMessages(helper.sent).at(-1)).toEqual({ id: 0, result: { decision: "accept" } });
  });

  it("auto-approves v2 file approval requests with decision accept", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(
            queue,
            encodeMessage({
              id: 0,
              method: "item/fileChange/requestApproval",
              params: { availableDecisions: ["accept", "cancel"] },
            }),
          );
          yield* Queue.offer(queue, encodeMessage(completedNotification));
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          yield* turn.completed;
        }),
      ),
    );

    expect(sentMessages(helper.sent).at(-1)).toEqual({ id: 0, result: { decision: "accept" } });
  });

  it("auto-approves permissions requests with granted permissions and turn scope", async () => {
    const permissions = { network: { enabled: true }, fileSystem: null };
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(
            queue,
            encodeMessage({
              id: 4,
              method: "item/permissions/requestApproval",
              params: { permissions },
            }),
          );
          yield* Queue.offer(queue, encodeMessage(completedNotification));
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          yield* turn.completed;
        }),
      ),
    );

    expect(sentMessages(helper.sent).at(-1)).toEqual({
      id: 4,
      result: { permissions: { network: { enabled: true } }, scope: "turn" },
    });
  });

  it("auto-approves legacy approval requests with decision approved", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(
            queue,
            encodeMessage({
              id: 7,
              method: "execCommandApproval",
              params: {},
            }),
          );
          yield* Queue.offer(queue, encodeMessage(completedNotification));
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          yield* turn.completed;
        }),
      ),
    );

    expect(sentMessages(helper.sent).at(-1)).toEqual({ id: 7, result: { decision: "approved" } });
  });

  it("maps turn/failed, turn/cancelled, and requestUserInput to tagged terminal errors", async () => {
    const cases = [
      {
        notification: {
          method: "turn/failed",
          params: { threadId: "thread-123", error: { message: "bad" } },
        },
        error: RunnerTurnFailedError,
      },
      {
        notification: {
          method: "turn/cancelled",
          params: { threadId: "thread-123", reason: "user" },
        },
        error: RunnerTurnCancelledError,
      },
      {
        notification: {
          method: "item/tool/requestUserInput",
          params: { threadId: "thread-123", prompt: "choose" },
        },
        error: RunnerTurnInputRequiredError,
      },
    ] as const;

    for (const testCase of cases) {
      const helper = await Effect.runPromise(
        makeScriptedStream((queue) =>
          Effect.gen(function* () {
            yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
            yield* Queue.offer(queue, encodeMessage(testCase.notification));
          }),
        ),
      );

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeSession({
              stream: helper.stream,
              cwd: "/work/repo",
              requestTimeoutMs: 1_000,
            });
            const turn = yield* startTurn({
              session,
              cwd: "/work/repo",
              prompt: "hello",
              timeoutMs: 1_000,
            });
            return yield* turn.completed;
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(testCase.error);
        }
      }
    }
  });

  it("maps failed and interrupted turn/completed statuses to tagged terminal errors", async () => {
    const cases = [
      {
        status: "failed",
        error: RunnerTurnFailedError,
      },
      {
        status: "interrupted",
        error: RunnerTurnCancelledError,
      },
    ] as const;

    for (const testCase of cases) {
      const helper = await Effect.runPromise(
        makeScriptedStream((queue) =>
          Effect.gen(function* () {
            yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
            yield* Queue.offer(
              queue,
              encodeMessage({
                method: "turn/completed",
                params: {
                  threadId: "thread-123",
                  turn: {
                    id: "turn-1",
                    items: [],
                    status: testCase.status,
                    error: { message: "bad", codexErrorInfo: null, additionalDetails: null },
                    startedAt: 1,
                    completedAt: 2,
                    durationMs: 1_000,
                  },
                },
              }),
            );
          }),
        ),
      );

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeSession({
              stream: helper.stream,
              cwd: "/work/repo",
              requestTimeoutMs: 1_000,
            });
            const turn = yield* startTurn({
              session,
              cwd: "/work/repo",
              prompt: "hello",
              timeoutMs: 1_000,
            });
            return yield* turn.completed;
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(testCase.error);
        }
      }
    }
  });

  it("fails when turn/start returns a JSON-RPC error", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Queue.offer(queue, encodeMessage({ id: 3, error: { message: "boom" } })),
      ),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(RunnerRequestError);
      }
    }
  });

  it("does not auto-approve requestUserInput notifications", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(
            queue,
            encodeMessage({
              id: 9,
              method: "item/tool/requestUserInput",
              params: { threadId: "thread-123", prompt: "choose" },
            }),
          );
        }),
      ),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          return yield* turn.completed;
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      sentMessages(helper.sent).some((message) => message.id === 9 && "result" in message),
    ).toBe(false);
  });

  it("surfaces approval send failure immediately", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream(
        (queue) =>
          Effect.gen(function* () {
            yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
            yield* Queue.offer(
              queue,
              encodeMessage({
                id: 0,
                method: "item/commandExecution/requestApproval",
                params: { availableDecisions: ["accept", "cancel"] },
              }),
            );
          }),
        (message) => {
          if (message.id === 0 && "result" in message) {
            return Effect.fail(new ProtocolSendError({ reason: "approval write failed" }));
          }
          return Effect.void;
        },
      ),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          return yield* turn.completed;
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProtocolSendError);
      }
    }
  });

  it("times out when no terminal notification arrives", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } })),
      ),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 5,
          });
          return yield* turn.completed;
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(RunnerTurnTimeoutError);
      }
    }
  });

  it("closes the event stream on timeout", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          yield* Queue.offer(
            queue,
            encodeMessage({ method: "item/started", params: { threadId: "thread-123" } }),
          );
        }),
      ),
    );

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 5,
          });
          yield* Effect.exit(turn.completed);
          return yield* Stream.runCollect(turn.events);
        }),
      ),
    );

    expect(Array.from(events).map((event) => event.method)).toEqual(["item/started"]);
  });

  it("fails when notifications end before a terminal turn event", async () => {
    const helper = await Effect.runPromise(
      makeScriptedStream((queue) =>
        Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } })).pipe(
          Effect.zipRight(Queue.shutdown(queue)),
        ),
      ),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const turn = yield* startTurn({
            session,
            cwd: "/work/repo",
            prompt: "hello",
            timeoutMs: 1_000,
          });
          return yield* turn.completed;
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(RunnerSessionClosedError);
      }
    }
  });
});
