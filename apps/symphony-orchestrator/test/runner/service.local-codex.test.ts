import { describe, expect, it } from "bun:test";

import { Effect, Exit, Queue, Stream } from "effect";

import { LocalCodexUnavailableError } from "../../src/runner/errors.js";
import { runTurn } from "../../src/runner/service.js";
import { encodeMessage, frameMessages, parseFrames } from "../../src/runner/transport.js";
import { makeLocalCodexStream } from "./test-helpers/local-codex.js";

const runOrSkip = async <A, E>(effect: Effect.Effect<A, E | LocalCodexUnavailableError>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit) && exit.cause.toString().includes(LocalCodexUnavailableError.name)) {
    console.warn(`Skipping local codex integration: ${exit.cause.toString()}`);
    return null;
  }
  if (Exit.isFailure(exit)) {
    throw new Error(exit.cause.toString());
  }
  return exit.value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const idOf = (message: unknown): number | null =>
  isRecord(message) && typeof message.id === "number" ? message.id : null;

const methodOf = (message: unknown): string | null =>
  isRecord(message) && typeof message.method === "string" ? message.method : null;

const isApprovalMethod = (method: string): boolean =>
  method === "applyPatchApproval" ||
  method === "execCommandApproval" ||
  method === "item/fileChange/requestApproval" ||
  method === "item/commandExecution/requestApproval" ||
  method === "item/permissions/requestApproval";

const approvalResult = (method: string): unknown => {
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: "approved" };
  }
  if (
    method === "item/fileChange/requestApproval" ||
    method === "item/commandExecution/requestApproval"
  ) {
    return { decision: "accept" };
  }
  return { permissions: {}, scope: "turn" };
};

const driveApprovalTurn = () =>
  Effect.gen(function* () {
    const local = yield* makeLocalCodexStream();
    const messages = yield* Queue.unbounded<unknown>();
    yield* parseFrames(frameMessages(local.stream.receive)).pipe(
      Stream.runForEach((message) => Queue.offer(messages, message)),
      Effect.forkScoped,
    );

    let nextId = 1;
    let approvalCount = 0;

    const handleApproval = (message: unknown) =>
      Effect.gen(function* () {
        const id = idOf(message);
        const method = methodOf(message);
        if (id !== null && method !== null && isApprovalMethod(method)) {
          approvalCount += 1;
          yield* local.stream.send(encodeMessage({ id, result: approvalResult(method) }));
        }
      });

    const request = (method: string, params: unknown) =>
      Effect.gen(function* () {
        const id = nextId++;
        yield* local.stream.send(encodeMessage({ id, method, params }));
        while (true) {
          const message = yield* Queue.take(messages);
          yield* handleApproval(message);
          if (idOf(message) === id && isRecord(message)) {
            return message.result;
          }
        }
      });

    yield* request("initialize", {
      clientInfo: { name: "switchyard-local-codex-test", version: "0.1" },
      capabilities: {},
    });
    const threadResult = yield* request("thread/start", {
      cwd: local.cwd,
      approvalPolicy: "on-request",
      sandbox: "read-only",
      ephemeral: true,
    });
    const threadId =
      isRecord(threadResult) &&
      isRecord(threadResult.thread) &&
      typeof threadResult.thread.id === "string"
        ? threadResult.thread.id
        : null;
    if (threadId === null) {
      throw new Error(`thread/start returned no thread id: ${JSON.stringify(threadResult)}`);
    }

    yield* local.stream.send(
      encodeMessage({
        id: nextId++,
        method: "turn/start",
        params: {
          threadId,
          cwd: local.cwd,
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          input: [
            {
              type: "text",
              text: "Create a new file named hello.txt in the current directory with the exact content 'hi' (no newline). Then reply with the single word DONE.",
            },
          ],
        },
      }),
    );

    while (true) {
      const message = yield* Queue.take(messages);
      yield* handleApproval(message);
      if (methodOf(message) === "turn/completed") {
        return { message, approvalCount, sent: local.sent };
      }
    }
  });

describe("local codex protocol canary", () => {
  it("drives a trivial turn through public AgentRunner.runTurn", async () => {
    const outcome = await runOrSkip(
      Effect.scoped(
        Effect.gen(function* () {
          const local = yield* makeLocalCodexStream();
          return yield* runTurn({
            stream: local.stream,
            cwd: local.cwd,
            prompt: "Respond with only the single word DONE and nothing else.",
            requestTimeoutMs: 60_000,
            turnTimeoutMs: 180_000,
          });
        }),
      ),
    );

    if (outcome === null) {
      return;
    }

    expect(outcome.kind).toBe("completed");
  }, 240_000);

  it("round-trips approval through direct session and turn composition", async () => {
    const outcome = await runOrSkip(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* driveApprovalTurn();
        }),
      ),
    );

    if (outcome === null) {
      return;
    }

    expect(outcome.message).toMatchObject({ params: { turn: { status: "completed" } } });
    expect(outcome.approvalCount).toBeGreaterThan(0);
    expect(outcome.sent).toContainEqual({ id: expect.any(Number), result: { decision: "accept" } });
  }, 240_000);
});
