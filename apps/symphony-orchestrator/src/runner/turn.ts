import { Deferred, Effect, Fiber, Option, Queue, Stream, type Scope } from "effect";

import {
  ProtocolSendError,
  RunnerProtocolError,
  RunnerRequestError,
  RunnerRequestTimeoutError,
  RunnerSessionClosedError,
  RunnerTurnCancelledError,
  RunnerTurnFailedError,
  RunnerTurnInputRequiredError,
  RunnerTurnTimeoutError,
} from "./errors.js";
import type { RunnerNotification, RunnerSession } from "./session.js";

export const DEFAULT_TURN_TIMEOUT_MS = 600_000;

export type TurnStartOptions = {
  readonly session: RunnerSession;
  readonly prompt: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
};

export type TurnRun = {
  readonly events: Stream.Stream<RunnerNotification>;
  readonly completed: Effect.Effect<unknown, TurnCompletionError>;
};

type TurnStartFailure =
  | ProtocolSendError
  | RunnerProtocolError
  | RunnerRequestError
  | RunnerRequestTimeoutError
  | RunnerSessionClosedError;

export type StartTurnError = TurnStartFailure | RunnerTurnTimeoutError;

export type TurnCompletionError =
  | ProtocolSendError
  | RunnerSessionClosedError
  | RunnerTurnCancelledError
  | RunnerTurnFailedError
  | RunnerTurnInputRequiredError
  | RunnerTurnTimeoutError;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const methodOf = (notification: RunnerNotification): string | null =>
  typeof notification.method === "string" ? notification.method : null;

const idOf = (notification: RunnerNotification): number | null =>
  typeof notification.id === "number" && Number.isInteger(notification.id) ? notification.id : null;

const makeTurnStartParams = (threadId: string, cwd: string, prompt: string): unknown => ({
  threadId,
  cwd,
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
  input: [{ type: "text", text: prompt }],
});

const stringifyReason = (reason: unknown): string =>
  typeof reason === "string" ? reason : JSON.stringify(reason);

const failureReason = (notification: RunnerNotification): unknown => {
  const params = notification.params;
  if (!isRecord(params)) {
    return params ?? notification.method;
  }
  return params.error ?? params.message ?? params.reason ?? params;
};

const inputPrompt = (notification: RunnerNotification): unknown => {
  const params = notification.params;
  if (!isRecord(params)) {
    return undefined;
  }
  return params.prompt ?? params.questions ?? params;
};

const terminalResult = (
  notification: RunnerNotification,
): Effect.Effect<
  unknown,
  RunnerTurnCancelledError | RunnerTurnFailedError | RunnerTurnInputRequiredError
> | null => {
  switch (methodOf(notification)) {
    case "turn/completed": {
      const params = notification.params;
      const turn = isRecord(params) && isRecord(params.turn) ? params.turn : null;
      const status = turn === null ? null : turn.status;
      if (turn !== null && status === "failed") {
        return Effect.fail(
          new RunnerTurnFailedError({
            reason: stringifyReason(turn.error ?? params),
          }),
        );
      }
      if (turn !== null && status === "interrupted") {
        return Effect.fail(
          new RunnerTurnCancelledError({
            reason: stringifyReason(turn.error ?? params),
          }),
        );
      }
      return Effect.succeed(notification.params);
    }
    case "turn/failed":
      return Effect.fail(
        new RunnerTurnFailedError({
          reason: stringifyReason(failureReason(notification)),
        }),
      );
    case "turn/cancelled":
      return Effect.fail(
        new RunnerTurnCancelledError({
          reason: stringifyReason(failureReason(notification)),
        }),
      );
    case "item/tool/requestUserInput":
      return Effect.fail(
        new RunnerTurnInputRequiredError({
          prompt: inputPrompt(notification),
        }),
      );
    default:
      return null;
  }
};

// Reused by the local-codex canary in test/runner/service.local-codex.test.ts so
// production and the canary share one approval-shape table.
export const approvalResponseFor = (notification: RunnerNotification): unknown | null => {
  const params = notification.params;
  switch (methodOf(notification)) {
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: "approved" };
    case "item/fileChange/requestApproval":
    case "item/commandExecution/requestApproval":
      return { decision: "accept" };
    case "item/permissions/requestApproval":
      if (isRecord(params) && isRecord(params.permissions)) {
        const permissions: Record<string, unknown> = {};
        if (params.permissions.network !== null && params.permissions.network !== undefined) {
          permissions.network = params.permissions.network;
        }
        if (params.permissions.fileSystem !== null && params.permissions.fileSystem !== undefined) {
          permissions.fileSystem = params.permissions.fileSystem;
        }
        return { permissions, scope: "turn" };
      }
      return { permissions: {}, scope: "turn" };
    default:
      return null;
  }
};

const autoApprove = (
  session: RunnerSession,
  notification: RunnerNotification,
): Effect.Effect<void, ProtocolSendError> => {
  const id = idOf(notification);
  const result = approvalResponseFor(notification);
  if (id === null || result === null) {
    return Effect.void;
  }
  return session.sendNotificationResponse(id, result);
};

export const startTurn = ({
  session,
  prompt,
  cwd,
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
}: TurnStartOptions): Effect.Effect<TurnRun, StartTurnError, Scope.Scope> =>
  Effect.gen(function* () {
    const eventQueue = yield* Queue.unbounded<Option.Option<RunnerNotification>>();
    const completedDeferred = yield* Deferred.make<unknown, TurnCompletionError>();
    yield* Effect.addFinalizer(() => Queue.shutdown(eventQueue));

    const watcher = Stream.runForEachWhile(session.notifications, (notification) =>
      Effect.gen(function* () {
        yield* Queue.offer(eventQueue, Option.some(notification));
        const approvalOk = yield* autoApprove(session, notification).pipe(
          Effect.as(true),
          Effect.catchAll((error) =>
            Deferred.fail(completedDeferred, error).pipe(
              Effect.zipRight(Queue.offer(eventQueue, Option.none())),
              Effect.as(false),
            ),
          ),
        );
        if (!approvalOk) {
          return false;
        }

        const terminal = terminalResult(notification);
        if (terminal !== null) {
          yield* terminal.pipe(
            Effect.matchEffect({
              onFailure: (error) => Deferred.fail(completedDeferred, error),
              onSuccess: (params) => Deferred.succeed(completedDeferred, params),
            }),
          );
          yield* Queue.offer(eventQueue, Option.none());
          return false;
        }
        return true;
      }),
    ).pipe(
      Effect.zipRight(
        Deferred.fail(
          completedDeferred,
          new RunnerSessionClosedError({
            reason: "session notifications ended before a terminal turn event",
          }),
        ).pipe(Effect.zipRight(Queue.offer(eventQueue, Option.none())), Effect.ignore),
      ),
    );

    const watcherFiber = yield* Effect.forkScoped(watcher);

    yield* session.request("turn/start", makeTurnStartParams(session.threadId, cwd, prompt), {
      timeoutMs,
    });

    return {
      events: Stream.fromQueue(eventQueue).pipe(
        Stream.takeWhile(Option.isSome),
        Stream.map((event) => event.value),
      ),
      completed: Effect.raceFirst(
        Deferred.await(completedDeferred),
        Effect.sleep(`${timeoutMs} millis`).pipe(
          Effect.zipRight(Fiber.interrupt(watcherFiber)),
          Effect.zipRight(Queue.offer(eventQueue, Option.none())),
          Effect.zipRight(
            Effect.fail(
              new RunnerTurnTimeoutError({
                threadId: session.threadId,
                timeoutMs,
              }),
            ),
          ),
        ),
      ),
    };
  });
