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
  readonly waitExit: Effect.Effect<
    DaytonaSessionExitInfo,
    DaytonaSessionNotFoundError | DaytonaSessionOpError
  >;
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

// waitExit polls a sandbox-side exit-code file written by a shell EXIT trap
// wrapped around the user's command. The OSS Daytona stack does not populate
// Command.exitCode on getSessionCommand for runAsync sessions, and its
// streaming-logs WebSocket does not reliably resolve when commands exit, so
// neither getSessionCommand nor getSessionCommandLogs is a usable exit-code
// signal in OSS. The wrapper is the workaround: every start()'s command is
// run inside `trap "echo $? > <exitFile>" EXIT\n<user_command>`, and waitExit
// polls the file via sandbox.process.executeCommand. Backoff: 50ms → 500ms,
// 30s overall deadline. Schema-decode and deadline failures surface as
// DaytonaSessionOpError; SDK 404 surfaces as DaytonaSessionNotFoundError.
//
// Backport-worthy: the SDK behavior should be confirmed against production
// Daytona Cloud; if its getSessionCommand populates exitCode, the wrapper
// can be retired. Until then, OSS dictates the file-poll path.
const WAIT_EXIT_INITIAL_DELAY_MS = 50;
const WAIT_EXIT_MAX_DELAY_MS = 500;
const WAIT_EXIT_DEADLINE_MS = 30_000;

const exitFilePath = (sessionId: string): string => `/tmp/${sessionId}-exit`;

const wrapCommandWithExitTrap = (sessionId: string, command: string): string =>
  `trap 'echo $? > ${exitFilePath(sessionId)}' EXIT\n${command}`;

const pollExit = (
  sandbox: Sandbox,
  sessionId: string,
): Effect.Effect<DaytonaSessionExitInfo, DaytonaSessionNotFoundError | DaytonaSessionOpError> => {
  const exitFile = exitFilePath(sessionId);
  const readExitFile = Effect.tryPromise({
    try: () => sandbox.process.executeCommand(`cat ${exitFile} 2>/dev/null`),
    catch: (error) => {
      if (isDaytonaNotFound(error)) {
        return new DaytonaSessionNotFoundError({
          sessionId,
          operation: "waitExit",
          reason: describeUnknown(error),
        });
      }

      return new DaytonaSessionOpError({
        sessionId,
        operation: "waitExit",
        reason: describeUnknown(error),
      });
    },
  });

  const loop = Effect.gen(function* () {
    let delay = WAIT_EXIT_INITIAL_DELAY_MS;
    while (true) {
      const result = yield* readExitFile;
      if (result.exitCode === 0) {
        const trimmed = (result.result ?? "").trim();
        if (trimmed.length > 0) {
          const parsed = Number.parseInt(trimmed, 10);
          if (Number.isFinite(parsed)) {
            return { exitCode: parsed } satisfies DaytonaSessionExitInfo;
          }
          return yield* Effect.fail(
            new DaytonaSessionOpError({
              sessionId,
              operation: "waitExit",
              reason: `exit-file ${exitFile} contained non-numeric value: ${trimmed}`,
            }),
          );
        }
      }
      yield* Effect.sleep(`${delay} millis`);
      delay = Math.min(delay * 2, WAIT_EXIT_MAX_DELAY_MS);
    }
  });

  return loop.pipe(
    Effect.timeoutFail({
      duration: `${WAIT_EXIT_DEADLINE_MS} millis`,
      onTimeout: () =>
        new DaytonaSessionOpError({
          sessionId,
          operation: "waitExit",
          reason: `exit-code poll deadline exceeded after ${WAIT_EXIT_DEADLINE_MS}ms`,
        }),
    }),
    Effect.withSpan("DaytonaSession.waitExit"),
  );
};

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

    const wrappedCommand = wrapCommandWithExitTrap(sessionId, command);
    const commandId = yield* executeSessionCommand(sandbox, sessionId, wrappedCommand);
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

    const waitExit = pollExit(sandbox, sessionId);

    const stream: ProtocolStream = {
      sessionId,
      commandId,
      receive,
      stderr,
      send,
      waitExit,
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
