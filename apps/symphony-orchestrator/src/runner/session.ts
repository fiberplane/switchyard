import { Cause, Deferred, Effect, Option, Queue, Ref, Stream, type Scope } from "effect";

import {
  ProtocolFramingError,
  ProtocolParseError,
  ProtocolRecvError,
  ProtocolSendError,
  RunnerProtocolError,
  RunnerRequestError,
  RunnerRequestTimeoutError,
  RunnerSessionClosedError,
} from "./errors.js";
import type { InitializeParams, InitializeResponse, v2 } from "./protocol/index.js";
import { encodeMessage, frameMessages, parseFrames, type ProtocolStream } from "./transport.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const SWITCHYARD_CLIENT_INFO = {
  name: "switchyard",
  version: "0.1",
  title: "Switchyard",
} as const;

export type RunnerRequestFailure =
  | ProtocolSendError
  | RunnerProtocolError
  | RunnerRequestError
  | RunnerRequestTimeoutError
  | RunnerSessionClosedError;

export type RunnerSessionStartError =
  | ProtocolFramingError
  | ProtocolParseError
  | ProtocolRecvError
  | RunnerRequestFailure;

export type RunnerNotification = Record<string, unknown>;

export type RunnerSession = {
  readonly threadId: string;
  readonly initialize: InitializeResponse;
  readonly thread: v2.ThreadStartResponse;
  readonly notifications: Stream.Stream<RunnerNotification>;
  readonly allocateRequestId: Effect.Effect<number>;
  readonly request: <A = unknown>(
    method: string,
    params: unknown,
    options?: RunnerRequestOptions,
  ) => Effect.Effect<A, RunnerRequestFailure>;
  readonly sendNotificationResponse: (
    requestId: number,
    result: unknown,
  ) => Effect.Effect<void, ProtocolSendError>;
};

export type RunnerRequestOptions = {
  readonly timeoutMs?: number;
};

export type MakeSessionOptions = {
  readonly stream: ProtocolStream;
  readonly cwd: string;
  readonly requestTimeoutMs?: number;
};

type PendingRequest = {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, RunnerRequestError | RunnerSessionClosedError>;
};

type ProtocolResponse = {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRequestId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

export const isProtocolResponse = (message: unknown): message is ProtocolResponse =>
  isRecord(message) && isRequestId(message.id) && ("result" in message || "error" in message);

const responseErrorReason = (error: unknown): string =>
  typeof error === "string" ? error : JSON.stringify(error);

const getThreadId = (result: unknown): Effect.Effect<string, RunnerProtocolError> => {
  if (!isRecord(result)) {
    return Effect.fail(
      new RunnerProtocolError({ reason: "thread/start result was not an object" }),
    );
  }

  const thread = result.thread;
  if (!isRecord(thread) || typeof thread.id !== "string" || thread.id.length === 0) {
    return Effect.fail(
      new RunnerProtocolError({ reason: "thread/start result did not include thread.id" }),
    );
  }

  return Effect.succeed(thread.id);
};

const requireInitializeResponse = (
  result: unknown,
): Effect.Effect<InitializeResponse, RunnerProtocolError> => {
  if (
    !isRecord(result) ||
    typeof result.userAgent !== "string" ||
    typeof result.codexHome !== "string" ||
    typeof result.platformFamily !== "string" ||
    typeof result.platformOs !== "string"
  ) {
    return Effect.fail(
      new RunnerProtocolError({ reason: "initialize result did not match required fields" }),
    );
  }

  return Effect.succeed(result as InitializeResponse);
};

const isThreadStatus = (value: unknown): boolean =>
  isRecord(value) && typeof value.type === "string";

const isThreadStartResponse = (result: unknown): result is v2.ThreadStartResponse => {
  if (!isRecord(result) || !isRecord(result.thread)) {
    return false;
  }

  const thread = result.thread;
  return (
    typeof thread.id === "string" &&
    (typeof thread.forkedFromId === "string" || thread.forkedFromId === null) &&
    typeof thread.preview === "string" &&
    typeof thread.ephemeral === "boolean" &&
    typeof thread.modelProvider === "string" &&
    typeof thread.createdAt === "number" &&
    typeof thread.updatedAt === "number" &&
    isThreadStatus(thread.status) &&
    (typeof thread.path === "string" || thread.path === null) &&
    typeof thread.cwd === "string" &&
    typeof thread.cliVersion === "string" &&
    typeof thread.source === "string" &&
    (typeof thread.agentNickname === "string" || thread.agentNickname === null) &&
    (typeof thread.agentRole === "string" || thread.agentRole === null) &&
    "gitInfo" in thread &&
    (typeof thread.name === "string" || thread.name === null) &&
    Array.isArray(thread.turns) &&
    typeof result.model === "string" &&
    typeof result.modelProvider === "string" &&
    (typeof result.serviceTier === "string" || result.serviceTier === null) &&
    typeof result.cwd === "string" &&
    Array.isArray(result.instructionSources) &&
    "approvalPolicy" in result &&
    "approvalsReviewer" in result &&
    isRecord(result.sandbox) &&
    ("reasoningEffort" in result || "activePermissionProfile" in result)
  );
};

const requireThreadStartResponse = (
  result: unknown,
): Effect.Effect<v2.ThreadStartResponse, RunnerProtocolError> => {
  if (!isThreadStartResponse(result)) {
    return Effect.fail(
      new RunnerProtocolError({ reason: "thread/start result did not match required fields" }),
    );
  }
  return Effect.succeed(result);
};

// Explicit `experimentalApi: false` — the generated `InitializeCapabilities`
// type requires the field, but real codex 0.128.0 also accepts `{}` (the
// shape used by codex-driver.cjs and the captured fixtures). Sending the
// documented default keeps the wire shape compatible while satisfying the
// generated bindings. Configurable capabilities are tracked under SWYRD-uouprnfv.
const makeInitializeParams = (): InitializeParams => ({
  clientInfo: SWITCHYARD_CLIENT_INFO,
  capabilities: { experimentalApi: false },
});

const makeThreadStartParams = (cwd: string): v2.ThreadStartParams => ({
  cwd,
  approvalPolicy: "never",
  sandbox: "danger-full-access",
  ephemeral: true,
});

const makeRequestMessage = (id: number, method: string, params: unknown): unknown => ({
  id,
  method,
  params,
});

const makeResponseMessage = (id: number, result: unknown): unknown => ({
  id,
  result,
});

const completePending = (
  pendingRef: Ref.Ref<Map<number, PendingRequest>>,
  response: ProtocolResponse,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pending = yield* Ref.get(pendingRef);
    const request = pending.get(response.id);
    if (request === undefined) {
      return;
    }

    yield* Ref.update(pendingRef, (current) => {
      const next = new Map(current);
      next.delete(response.id);
      return next;
    });

    if ("error" in response) {
      yield* Deferred.fail(
        request.deferred,
        new RunnerRequestError({
          method: request.method,
          requestId: response.id,
          reason: responseErrorReason(response.error),
        }),
      );
      return;
    }

    yield* Deferred.succeed(request.deferred, response.result);
  });

const failAllPending = (
  pendingRef: Ref.Ref<Map<number, PendingRequest>>,
  error: RunnerSessionClosedError,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pending = yield* Ref.getAndSet(pendingRef, new Map());
    yield* Effect.forEach(pending.values(), (request) => Deferred.fail(request.deferred, error), {
      discard: true,
    });
  });

const startMessageRouter = (
  stream: ProtocolStream,
  pendingRef: Ref.Ref<Map<number, PendingRequest>>,
  closedRef: Ref.Ref<Option.Option<RunnerSessionClosedError>>,
  notifications: Queue.Queue<RunnerNotification>,
): Effect.Effect<void, never, Scope.Scope> => {
  const messages = parseFrames(frameMessages(stream.receive));

  const routeMessage = (message: unknown): Effect.Effect<void> => {
    if (isProtocolResponse(message)) {
      return completePending(pendingRef, message);
    }

    if (isRecord(message)) {
      return Queue.offer(notifications, message);
    }

    return Effect.void;
  };

  const closeWith = (error: RunnerSessionClosedError): Effect.Effect<void> =>
    Ref.set(closedRef, Option.some(error)).pipe(Effect.zipRight(failAllPending(pendingRef, error)));

  const reader = Stream.runForEach(messages, routeMessage).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        closeWith(
          new RunnerSessionClosedError({
            reason: Cause.pretty(cause),
          }),
        ),
      onSuccess: () =>
        closeWith(
          new RunnerSessionClosedError({
            reason: "protocol receive stream ended",
          }),
        ),
    }),
    Effect.ignore,
    Effect.ensuring(Queue.shutdown(notifications)),
  );

  return Effect.forkScoped(reader).pipe(Effect.asVoid);
};

const makeRequest =
  (
    stream: ProtocolStream,
    nextIdRef: Ref.Ref<number>,
    pendingRef: Ref.Ref<Map<number, PendingRequest>>,
    closedRef: Ref.Ref<Option.Option<RunnerSessionClosedError>>,
    defaultTimeoutMs: number,
  ) =>
  <A = unknown>(
    method: string,
    params: unknown,
    options?: RunnerRequestOptions,
  ): Effect.Effect<A, RunnerRequestFailure> =>
    Effect.gen(function* () {
      const closed = yield* Ref.get(closedRef);
      if (Option.isSome(closed)) {
        return yield* Effect.fail(closed.value);
      }

      const requestId = yield* Ref.getAndUpdate(nextIdRef, (id) => id + 1);
      const deferred = yield* Deferred.make<
        unknown,
        RunnerRequestError | RunnerSessionClosedError
      >();
      yield* Ref.update(pendingRef, (current) => {
        const next = new Map(current);
        next.set(requestId, { method, deferred });
        return next;
      });

      const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
      const awaitResponse = Deferred.await(deferred).pipe(
        Effect.timeoutFail({
          duration: `${timeoutMs} millis`,
          onTimeout: () =>
            new RunnerRequestTimeoutError({
              method,
              requestId,
              timeoutMs,
            }),
        }),
        Effect.onExit(() =>
          Ref.update(pendingRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          }),
        ),
      );

      yield* stream.send(encodeMessage(makeRequestMessage(requestId, method, params))).pipe(
        Effect.catchAll((error) =>
          Ref.update(pendingRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          }).pipe(Effect.zipRight(Effect.fail(error))),
        ),
      );

      return (yield* awaitResponse) as A;
    });

export const makeSession = ({
  stream,
  cwd,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: MakeSessionOptions): Effect.Effect<RunnerSession, RunnerSessionStartError, Scope.Scope> =>
  Effect.gen(function* () {
    const pendingRef = yield* Ref.make<Map<number, PendingRequest>>(new Map());
    const closedRef = yield* Ref.make<Option.Option<RunnerSessionClosedError>>(Option.none());
    const nextIdRef = yield* Ref.make(1);
    const notificationsQueue = yield* Queue.unbounded<RunnerNotification>();
    yield* startMessageRouter(stream, pendingRef, closedRef, notificationsQueue);
    yield* Effect.addFinalizer(() =>
      Ref.set(
        closedRef,
        Option.some(
          new RunnerSessionClosedError({
            reason: "session scope closed",
          }),
        ),
      ).pipe(
        Effect.zipRight(
          failAllPending(
            pendingRef,
            new RunnerSessionClosedError({
              reason: "session scope closed",
            }),
          ),
        ),
      ),
    );

    const request = makeRequest(stream, nextIdRef, pendingRef, closedRef, requestTimeoutMs);
    const initialize = yield* request("initialize", makeInitializeParams()).pipe(
      Effect.flatMap(requireInitializeResponse),
    );
    const thread = yield* request("thread/start", makeThreadStartParams(cwd)).pipe(
      Effect.flatMap(requireThreadStartResponse),
    );
    const threadId = yield* getThreadId(thread);

    return {
      threadId,
      initialize,
      thread,
      notifications: Stream.fromQueue(notificationsQueue),
      allocateRequestId: Ref.getAndUpdate(nextIdRef, (id) => id + 1),
      request,
      sendNotificationResponse: (requestId, result) =>
        stream.send(encodeMessage(makeResponseMessage(requestId, result))),
    };
  });
