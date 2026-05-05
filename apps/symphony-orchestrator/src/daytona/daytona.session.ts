import type { Daytona, Sandbox } from "@daytona/sdk";
import {
  Context,
  Effect,
  Layer,
  Option,
  ParseResult,
  Queue,
  Ref,
  Schema,
  Stream,
  type Scope,
} from "effect";

import { createDaytonaClient, describeUnknown, isDaytonaNotFound } from "./daytona-client.js";
import {
  DaytonaSandboxNotFoundError,
  DaytonaSessionCreateError,
  DaytonaSessionExecError,
  DaytonaSessionInputError,
  DaytonaSessionLogError,
  DaytonaSessionNotFoundError,
  DaytonaSessionOpError,
} from "./errors.js";
import type { DaytonaConfig, SandboxHandle } from "./models.js";
import { DaytonaSessionExecuteResponseSchema } from "./session-models.js";

// Bounded-queue capacity for stdout/stderr bridging from the SDK's synchronous
// callback into an Effect Stream. Drop-with-log on overflow is the locked
// policy — Effect.runSync(Queue.offer(...)) on a full bounded queue would
// throw AsyncFiberException into the WebSocket fiber, so the bridge uses
// Queue.unsafeOffer (non-blocking, returns false on full) and emits an
// Effect.logWarning when a chunk is dropped. Contract is orchestrator-heap
// protection only; we have no signal from @daytona/sdk that its WebSocket
// reader pauses when the callback blocks, so SDK-internal buffering is out
// of our control and chunks may be dropped when the consumer falls behind.
const STDOUT_QUEUE_CAPACITY = 64;

export type DaytonaSessionExitInfo = {
  readonly exitCode: number;
};

export type ProtocolStream = {
  readonly sessionId: string;
  readonly commandId: string;
  readonly receive: Stream.Stream<string, DaytonaSessionLogError>;
  readonly stderr: Stream.Stream<string, DaytonaSessionLogError>;
  readonly send: (
    data: string,
  ) => Effect.Effect<void, DaytonaSessionInputError | DaytonaSessionNotFoundError>;
};

export type DaytonaSessionStartError =
  | DaytonaSandboxNotFoundError
  | DaytonaSessionCreateError
  | DaytonaSessionExecError
  | DaytonaSessionLogError
  | DaytonaSessionNotFoundError
  | DaytonaSessionOpError;

export type DaytonaSessionShape = {
  readonly start: (
    handle: SandboxHandle,
    command: string,
  ) => Effect.Effect<ProtocolStream, DaytonaSessionStartError, Scope.Scope>;
};

export class DaytonaSession extends Context.Tag("DaytonaSession")<
  DaytonaSession,
  DaytonaSessionShape
>() {}

const generateSessionId = (): string => `swyrd-${crypto.randomUUID()}`;

const getSandboxForSession = (
  client: Daytona,
  sandboxId: string,
): Effect.Effect<Sandbox, DaytonaSandboxNotFoundError | DaytonaSessionOpError> =>
  Effect.tryPromise({
    try: () => client.get(sandboxId),
    catch: (error) => {
      if (isDaytonaNotFound(error)) {
        return new DaytonaSandboxNotFoundError({
          sandboxId,
          operation: "createSession",
          reason: describeUnknown(error),
        });
      }

      return new DaytonaSessionOpError({
        sessionId: "n/a",
        operation: "getSandbox",
        reason: describeUnknown(error),
      });
    },
  });

const createSession = (
  sandbox: Sandbox,
  sandboxId: string,
  sessionId: string,
): Effect.Effect<void, DaytonaSessionCreateError | DaytonaSandboxNotFoundError> =>
  Effect.tryPromise({
    try: () => sandbox.process.createSession(sessionId),
    catch: (error) => {
      if (isDaytonaNotFound(error)) {
        return new DaytonaSandboxNotFoundError({
          sandboxId,
          operation: "createSession",
          reason: describeUnknown(error),
        });
      }

      return new DaytonaSessionCreateError({
        sandboxId,
        reason: describeUnknown(error),
      });
    },
  }).pipe(Effect.asVoid);

const releaseSession = (sandbox: Sandbox, sessionId: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => sandbox.process.deleteSession(sessionId),
    catch: (error) => error,
  }).pipe(Effect.ignore);

const executeSessionCommand = (
  sandbox: Sandbox,
  sessionId: string,
  command: string,
): Effect.Effect<string, DaytonaSessionExecError | DaytonaSessionNotFoundError> =>
  Effect.tryPromise({
    try: () => sandbox.process.executeSessionCommand(sessionId, { command, runAsync: true }),
    catch: (error) => {
      if (isDaytonaNotFound(error)) {
        return new DaytonaSessionNotFoundError({
          sessionId,
          operation: "executeSessionCommand",
          reason: describeUnknown(error),
        });
      }

      return new DaytonaSessionExecError({
        sessionId,
        reason: describeUnknown(error),
      });
    },
  }).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknown(DaytonaSessionExecuteResponseSchema)(response).pipe(
        Effect.catchTag("ParseError", (parseError) =>
          Effect.fail(
            new DaytonaSessionExecError({
              sessionId,
              reason: `executeSessionCommand response decode failed: ${ParseResult.TreeFormatter.formatErrorSync(parseError)}`,
            }),
          ),
        ),
      ),
    ),
    Effect.map(({ cmdId }) => cmdId),
  );

type DropEvent = {
  readonly channel: "stdout" | "stderr";
  readonly droppedBytes: number;
};

const offerOrEnqueueDrop = (
  queue: Queue.Queue<string>,
  dropQueue: Queue.Queue<DropEvent>,
  channel: "stdout" | "stderr",
  chunk: string,
): void => {
  if (!Queue.unsafeOffer(queue, chunk)) {
    // Drop policy: when the bounded queue is full, drop the chunk and surface
    // the loss via a scope-bound fiber that drains dropQueue into
    // Effect.logWarning. We never block in the SDK callback (synchronous) and
    // never call Effect.runSync from here — both would defect into the
    // WebSocket fiber and tear down the stream.
    Queue.unsafeOffer(dropQueue, { channel, droppedBytes: chunk.length });
  }
};

const buildLogStreams = (
  sandbox: Sandbox,
  sessionId: string,
  commandId: string,
): Effect.Effect<
  {
    readonly receive: Stream.Stream<string, DaytonaSessionLogError>;
    readonly stderr: Stream.Stream<string, DaytonaSessionLogError>;
  },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const stdoutQueue = yield* Queue.bounded<string>(STDOUT_QUEUE_CAPACITY);
    const stderrQueue = yield* Queue.bounded<string>(STDOUT_QUEUE_CAPACITY);
    const dropQueue = yield* Queue.unbounded<DropEvent>();
    const errorRef = yield* Ref.make<Option.Option<DaytonaSessionLogError>>(Option.none());

    yield* Effect.forkScoped(
      Stream.fromQueue(dropQueue).pipe(
        Stream.tap((event) =>
          Effect.logWarning("DaytonaSession dropped chunk; consumer too slow").pipe(
            Effect.annotateLogs({
              sessionId,
              commandId,
              channel: event.channel,
              droppedBytes: event.droppedBytes,
              queueCapacity: STDOUT_QUEUE_CAPACITY,
            }),
          ),
        ),
        Stream.runDrain,
      ),
    );

    const driver = Effect.tryPromise({
      try: () =>
        sandbox.process.getSessionCommandLogs(
          sessionId,
          commandId,
          (chunk) => {
            offerOrEnqueueDrop(stdoutQueue, dropQueue, "stdout", chunk);
          },
          (chunk) => {
            offerOrEnqueueDrop(stderrQueue, dropQueue, "stderr", chunk);
          },
        ),
      catch: (error) =>
        new DaytonaSessionLogError({
          sessionId,
          commandId,
          reason: describeUnknown(error),
        }),
    }).pipe(
      Effect.tapError((err) => Ref.set(errorRef, Option.some(err))),
      Effect.ensuring(Queue.shutdown(stdoutQueue)),
      Effect.ensuring(Queue.shutdown(stderrQueue)),
      Effect.ensuring(Queue.shutdown(dropQueue)),
      Effect.withSpan("DaytonaSession.streamLogs"),
    );

    yield* Effect.forkScoped(driver);

    const checkError = Stream.fromEffect(
      Ref.get(errorRef).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Effect.fail })),
      ),
    ).pipe(Stream.drain);

    const receive = Stream.fromQueue(stdoutQueue).pipe(Stream.concat(checkError));
    const stderr = Stream.fromQueue(stderrQueue).pipe(Stream.concat(checkError));

    return { receive, stderr };
  });

const start = (
  client: Daytona,
  handle: SandboxHandle,
  command: string,
): Effect.Effect<ProtocolStream, DaytonaSessionStartError, Scope.Scope> =>
  Effect.gen(function* () {
    const sandbox = yield* getSandboxForSession(client, handle.id);
    const sessionId = generateSessionId();

    yield* Effect.acquireRelease(createSession(sandbox, handle.id, sessionId), () =>
      releaseSession(sandbox, sessionId),
    );

    const commandId = yield* executeSessionCommand(sandbox, sessionId, command);
    const { receive, stderr } = yield* buildLogStreams(sandbox, sessionId, commandId);

    const send = (data: string) =>
      Effect.tryPromise({
        try: () => sandbox.process.sendSessionCommandInput(sessionId, commandId, data),
        catch: (error) => {
          if (isDaytonaNotFound(error)) {
            return new DaytonaSessionNotFoundError({
              sessionId,
              operation: "sendSessionCommandInput",
              reason: describeUnknown(error),
            });
          }

          return new DaytonaSessionInputError({
            sessionId,
            commandId,
            reason: describeUnknown(error),
          });
        },
      }).pipe(Effect.asVoid, Effect.withSpan("DaytonaSession.send"));

    const stream: ProtocolStream = {
      sessionId,
      commandId,
      receive,
      stderr,
      send,
    };

    return stream;
  }).pipe(Effect.withSpan("DaytonaSession.start"));

export const DaytonaSessionLive = (config: DaytonaConfig) =>
  Layer.effect(
    DaytonaSession,
    Effect.sync(() => {
      const client = createDaytonaClient(config);

      return {
        start: (handle, command) => start(client, handle, command),
      };
    }),
  );
