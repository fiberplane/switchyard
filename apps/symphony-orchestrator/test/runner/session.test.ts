import { describe, expect, it } from "bun:test";

import { Cause, Effect, Exit, Queue, Stream } from "effect";

import {
  ProtocolSendError,
  RunnerProtocolError,
  RunnerRequestError,
  RunnerRequestTimeoutError,
  RunnerSessionClosedError,
} from "../../src/runner/errors.js";
import type { v2 } from "../../src/runner/protocol/index.js";
import { isProtocolResponse, makeSession } from "../../src/runner/session.js";
import { encodeMessage, type ProtocolStream } from "../../src/runner/transport.js";

const decoder = new TextDecoder();

const collectSentMessages = (
  sent: ReadonlyArray<Uint8Array>,
): ReadonlyArray<Record<string, unknown>> =>
  sent.map((bytes) => JSON.parse(decoder.decode(bytes)) as Record<string, unknown>);

const streamFromMessages = (messages: ReadonlyArray<unknown>): ProtocolStream => ({
  send: () => Effect.void,
  receive: Stream.fromIterable(messages.map(encodeMessage)),
});

type ScriptedStreamHelper = {
  readonly stream: ProtocolStream;
  readonly sent: ReadonlyArray<Uint8Array>;
};

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

const makeScriptedSessionStream = (): Effect.Effect<ScriptedStreamHelper> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Uint8Array>();
    const sent: Uint8Array[] = [];

    const stream: ProtocolStream = {
      send: (bytes) =>
        Effect.gen(function* () {
          sent.push(bytes);
          const message = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
          if (message.method === "initialize") {
            yield* Queue.offer(queue, encodeMessage(initializeResponse));
          }
          if (message.method === "thread/start") {
            yield* Queue.offer(
              queue,
              encodeMessage({
                method: "configWarning",
                params: {
                  summary: "sandbox warning",
                  details: null,
                },
              }),
            );
            yield* Queue.offer(
              queue,
              encodeMessage({
                method: "remoteControl/status/changed",
                params: {
                  status: "disabled",
                  environmentId: null,
                },
              }),
            );
            yield* Queue.offer(queue, encodeMessage(threadStartResponse));
          }
        }),
      receive: Stream.fromQueue(queue),
    };

    return { stream, sent };
  });

const makeQueueBackedStream = (
  onSend: (
    message: Record<string, unknown>,
    queue: Queue.Queue<Uint8Array>,
  ) => Effect.Effect<void, ProtocolSendError>,
): Effect.Effect<ScriptedStreamHelper> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Uint8Array>();
    const sent: Uint8Array[] = [];
    const stream: ProtocolStream = {
      send: (bytes) =>
        Effect.gen(function* () {
          sent.push(bytes);
          const message = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
          yield* onSend(message, queue);
        }),
      receive: Stream.fromQueue(queue),
    };
    return { stream, sent };
  });

describe("makeSession", () => {
  it("sends initialize and thread/start, captures the thread id, and does not send initialized", async () => {
    const helper = await Effect.runPromise(makeScriptedSessionStream());

    const session = await Effect.runPromise(
      Effect.scoped(
        makeSession({
          stream: helper.stream,
          cwd: "/work/repo",
          requestTimeoutMs: 1_000,
        }),
      ),
    );

    expect(session.threadId).toBe("thread-123");
    expect(session.initialize.userAgent).toBe("switchyard-test/0.1");

    const sent = collectSentMessages(helper.sent);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "switchyard",
          title: "Switchyard",
          version: "0.1",
        },
        capabilities: { experimentalApi: false },
      },
    });
    expect(sent[1]).toMatchObject({
      id: 2,
      method: "thread/start",
      params: {
        cwd: "/work/repo",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: true,
      },
    });
    expect(sent.some((msg) => msg.method === "initialized")).toBe(false);
  });

  it("routes non-response frames to the notification stream while waiting for request responses", async () => {
    const helper = await Effect.runPromise(makeScriptedSessionStream());

    const notifications = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          return yield* Stream.runCollect(session.notifications.pipe(Stream.take(2)));
        }),
      ),
    );

    const methods = Array.from(notifications).map((notification) => notification.method);
    expect(methods).toEqual(["configWarning", "remoteControl/status/changed"]);
  });

  it("classifies server-initiated approval requests as notifications, not responses", () => {
    const approvalRequest = {
      method: "item/commandExecution/requestApproval",
      id: 0,
      params: {
        availableDecisions: ["accept", "cancel"],
      },
    };

    expect(isProtocolResponse(approvalRequest)).toBe(false);
  });

  it("exposes monotonic request id allocation after the handshake", async () => {
    const helper = await Effect.runPromise(makeScriptedSessionStream());

    const ids = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const first = yield* session.allocateRequestId;
          const second = yield* session.allocateRequestId;
          return [first, second] as const;
        }),
      ),
    );

    expect(ids).toEqual([3, 4]);
  });

  it("fails a request when the matching response contains error", async () => {
    const stream = streamFromMessages([{ id: 1, error: { message: "initialize rejected" } }]);

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeSession({
          stream,
          cwd: "/work/repo",
          requestTimeoutMs: 1_000,
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

  it("times out pending requests when no response arrives", async () => {
    const stream: ProtocolStream = {
      send: () => Effect.void,
      receive: Stream.never,
    };

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeSession({
          stream,
          cwd: "/work/repo",
          requestTimeoutMs: 5,
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(RunnerRequestTimeoutError);
      }
    }
  });

  it("can send a response to a server-initiated request using the server's id", async () => {
    const helper = await Effect.runPromise(
      makeQueueBackedStream((message, queue) => {
        if (message.method === "initialize") {
          return Queue.offer(queue, encodeMessage(initializeResponse));
        }
        if (message.method === "thread/start") {
          return Effect.gen(function* () {
            yield* Queue.offer(
              queue,
              encodeMessage({
                method: "item/commandExecution/requestApproval",
                id: 0,
                params: {
                  availableDecisions: ["accept", "cancel"],
                },
              }),
            );
            yield* Queue.offer(queue, encodeMessage(threadStartResponse));
          });
        }
        return Effect.void;
      }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          const notification = yield* Stream.runHead(session.notifications);
          if (notification._tag === "None") {
            throw new Error("expected notification");
          }
          yield* session.sendNotificationResponse(notification.value.id as number, {
            decision: "accept",
          });
        }),
      ),
    );

    const sent = collectSentMessages(helper.sent);
    expect(sent.at(-1)).toEqual({ id: 0, result: { decision: "accept" } });
  });

  it("ignores unrelated responses and resolves the matching request id", async () => {
    const helper = await Effect.runPromise(
      makeQueueBackedStream((message, queue) => {
        if (message.method === "initialize") {
          return Queue.offer(queue, encodeMessage(initializeResponse));
        }
        if (message.method === "thread/start") {
          return Effect.gen(function* () {
            yield* Queue.offer(queue, encodeMessage({ id: 99, result: { ignored: true } }));
            yield* Queue.offer(queue, encodeMessage(threadStartResponse));
          });
        }
        return Effect.void;
      }),
    );

    const session = await Effect.runPromise(
      Effect.scoped(
        makeSession({
          stream: helper.stream,
          cwd: "/work/repo",
          requestTimeoutMs: 1_000,
        }),
      ),
    );

    expect(session.threadId).toBe("thread-123");
  });

  it("fails when thread/start returns no canonical thread.id", async () => {
    const helper = await Effect.runPromise(
      makeQueueBackedStream((message, queue) => {
        if (message.method === "initialize") {
          return Queue.offer(queue, encodeMessage(initializeResponse));
        }
        if (message.method === "thread/start") {
          return Queue.offer(queue, encodeMessage({ id: 2, result: { threadId: "legacy" } }));
        }
        return Effect.void;
      }),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeSession({
          stream: helper.stream,
          cwd: "/work/repo",
          requestTimeoutMs: 1_000,
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(RunnerProtocolError);
      }
    }
  });

  it("propagates send failure and does not poison later request ids", async () => {
    let failInitialize = true;
    const helper = await Effect.runPromise(
      makeQueueBackedStream((message, queue) => {
        if (message.method === "initialize" && failInitialize) {
          failInitialize = false;
          return Effect.fail(new ProtocolSendError({ reason: "write failed" }));
        }
        if (message.method === "initialize") {
          return Queue.offer(queue, encodeMessage(initializeResponse));
        }
        if (message.method === "thread/start") {
          return Queue.offer(queue, encodeMessage(threadStartResponse));
        }
        return Effect.void;
      }),
    );

    const first = await Effect.runPromiseExit(
      Effect.scoped(
        makeSession({
          stream: helper.stream,
          cwd: "/work/repo",
          requestTimeoutMs: 1_000,
        }),
      ),
    );
    expect(Exit.isFailure(first)).toBe(true);

    const second = await Effect.runPromise(
      Effect.scoped(
        makeSession({
          stream: helper.stream,
          cwd: "/work/repo",
          requestTimeoutMs: 1_000,
        }),
      ),
    );
    expect(second.threadId).toBe("thread-123");
  });

  it("fails pending requests when the reader hits malformed JSON", async () => {
    const encoder = new TextEncoder();
    const helper = await Effect.runPromise(
      makeQueueBackedStream((message, queue) => {
        if (message.method === "initialize") {
          return Queue.offer(queue, encodeMessage(initializeResponse));
        }
        if (message.method === "thread/start") {
          return Queue.offer(queue, encoder.encode("{malformed-json\n"));
        }
        return Effect.void;
      }),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeSession({
          stream: helper.stream,
          cwd: "/work/repo",
          requestTimeoutMs: 1_000,
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

  it("fails pending requests when the receive stream ends before a response", async () => {
    const helper = await Effect.runPromise(
      makeQueueBackedStream((message, queue) => {
        if (message.method === "initialize") {
          return Queue.offer(queue, encodeMessage(initializeResponse));
        }
        if (message.method === "thread/start") {
          return Queue.shutdown(queue);
        }
        return Effect.void;
      }),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeSession({
          stream: helper.stream,
          cwd: "/work/repo",
          requestTimeoutMs: 1_000,
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

  it("fails later requests immediately after the receive stream has closed", async () => {
    const helper = await Effect.runPromise(
      makeQueueBackedStream((message, queue) => {
        if (message.method === "initialize") {
          return Queue.offer(queue, encodeMessage(initializeResponse));
        }
        if (message.method === "thread/start") {
          return Queue.offer(queue, encodeMessage(threadStartResponse)).pipe(
            Effect.zipRight(Queue.shutdown(queue)),
          );
        }
        return Effect.void;
      }),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            stream: helper.stream,
            cwd: "/work/repo",
            requestTimeoutMs: 1_000,
          });
          yield* Effect.sleep("10 millis");
          return yield* session.request("model/list", {});
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
