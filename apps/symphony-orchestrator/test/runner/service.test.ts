import { describe, expect, it } from "bun:test";

import { Effect, Exit, Layer, Queue, Stream } from "effect";

import { RunnerTurnTimeoutError } from "../../src/runner/errors.js";
import { AgentRunner, AgentRunnerLive, runTurn } from "../../src/runner/service.js";
import { encodeMessage, type ProtocolStream } from "../../src/runner/transport.js";

const decoder = new TextDecoder();

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

const happyPathStream = (): Effect.Effect<ProtocolStream> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Uint8Array>();
    return {
      send: (bytes) =>
        Effect.gen(function* () {
          const message = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
          if (message.method === "initialize") {
            yield* Queue.offer(
              queue,
              encodeMessage({
                id: message.id,
                result: {
                  userAgent: "switchyard-test/0.1",
                  codexHome: "/tmp/codex-home",
                  platformFamily: "unix",
                  platformOs: "linux",
                },
              }),
            );
          }
          if (message.method === "thread/start") {
            yield* Queue.offer(
              queue,
              encodeMessage({
                id: message.id,
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
                },
              }),
            );
          }
          if (message.method === "turn/start") {
            yield* Queue.offer(
              queue,
              encodeMessage({ id: message.id, result: { turn: { id: "turn-1" } } }),
            );
            yield* Queue.offer(queue, encodeMessage(completedNotification));
          }
        }),
      receive: Stream.fromQueue(queue),
    };
  });

const timeoutStream = (): Effect.Effect<ProtocolStream> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Uint8Array>();
    return {
      send: (bytes) =>
        Effect.gen(function* () {
          const message = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
          if (message.method === "initialize") {
            yield* Queue.offer(
              queue,
              encodeMessage({
                id: 1,
                result: {
                  userAgent: "switchyard-test/0.1",
                  codexHome: "/tmp/codex-home",
                  platformFamily: "unix",
                  platformOs: "linux",
                },
              }),
            );
          }
          if (message.method === "thread/start") {
            yield* Queue.offer(
              queue,
              encodeMessage({
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
                },
              }),
            );
          }
          if (message.method === "turn/start") {
            yield* Queue.offer(queue, encodeMessage({ id: 3, result: { turn: { id: "turn-1" } } }));
          }
        }),
      receive: Stream.fromQueue(queue),
    };
  });

describe("AgentRunner", () => {
  it("composes session and turn into a completed outcome over the happy-path fixture", async () => {
    const stream = await Effect.runPromise(happyPathStream());

    const outcome = await Effect.runPromise(
      Effect.scoped(
        runTurn({
          stream,
          cwd: "/work/repo",
          prompt: "Respond with only the single word DONE and nothing else.",
          requestTimeoutMs: 1_000,
          turnTimeoutMs: 1_000,
        }),
      ),
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.result).toMatchObject({
        turn: {
          status: "completed",
        },
      });
    }
  });

  it("is available as an Effect service through AgentRunnerLive", async () => {
    const stream = await Effect.runPromise(happyPathStream());

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* AgentRunner;
          return yield* runner.runTurn({
            stream,
            cwd: "/work/repo",
            prompt: "Respond with only the single word DONE and nothing else.",
            requestTimeoutMs: 1_000,
            turnTimeoutMs: 1_000,
          });
        }),
      ).pipe(Effect.provide(Layer.merge(AgentRunnerLive, Layer.empty))),
    );

    expect(outcome.kind).toBe("completed");
  });

  it("leaves infrastructure failures in the error channel", async () => {
    const stream = await Effect.runPromise(timeoutStream());

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        runTurn({
          stream,
          cwd: "/work/repo",
          prompt: "Respond with only the single word DONE and nothing else.",
          requestTimeoutMs: 1_000,
          turnTimeoutMs: 1,
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(RunnerTurnTimeoutError.name);
    }
  });
});
