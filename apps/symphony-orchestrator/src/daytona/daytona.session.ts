import type { Daytona, Sandbox } from "@daytona/sdk";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
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
//
// Capacity is 1024 to absorb a typical codex app-server turn's burst of
// JSON-RPC frames without dropping. The cycle 13 burst test verifies a
// 1000-line emission round-trips at this capacity. If real-world traffic
// exceeds the capacity, drops surface via Effect.logWarning so operators
// can tune. Backport-worthy: the production runner leaf may want to make
// this configurable per-session if the orchestrator-service leaf observes
// real-world drop rates above a threshold.
const STDOUT_QUEUE_CAPACITY = 1024;

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
  // Idempotent. Callers who want to release the session before the scope
  // exits can yield* stream.close. The same Effect is registered as the
  // scope finalizer via Effect.acquireRelease, so consumers who rely on
  // scope-driven cleanup don't need to call close themselves.
  readonly close: Effect.Effect<void>;
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
  sessionId: string,
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
        sessionId,
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

const waitForSessionInputPipe = (
  sandbox: Sandbox,
  sessionId: string,
  commandId: string,
): Effect.Effect<void, DaytonaSessionExecError | DaytonaSessionNotFoundError> => {
  const inputPipe = `/home/daytona/.daytona/sessions/${sessionId}/${commandId}/input.pipe`;
  const deadline = Date.now() + 5_000;

  const poll = (): Effect.Effect<void, DaytonaSessionExecError | DaytonaSessionNotFoundError> =>
    Effect.tryPromise({
      try: () => sandbox.process.executeCommand(`test -p ${inputPipe}`),
      catch: (error) => {
        if (isDaytonaNotFound(error)) {
          return new DaytonaSessionNotFoundError({
            sessionId,
            operation: "waitForSessionInputPipe",
            reason: describeUnknown(error),
          });
        }

        return new DaytonaSessionExecError({
          sessionId,
          reason: describeUnknown(error),
        });
      },
    }).pipe(
      Effect.flatMap((result) => {
        if (result.exitCode === 0) {
          return Effect.void;
        }
        if (Date.now() >= deadline) {
          return Effect.fail(
            new DaytonaSessionExecError({
              sessionId,
              reason: `input pipe was not ready for command ${commandId} within 5000ms`,
            }),
          );
        }
        return Effect.sleep("50 millis").pipe(Effect.zipRight(poll()));
      }),
    );

  return poll().pipe(Effect.withSpan("DaytonaSession.waitForInputPipe"));
};

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

// The grace window the driver waits, after the SDK's streaming Promise has
// resolved cleanly, for the watcher's exit-file observation to catch up.
// If the watcher does not resolve the shared exitDeferred within this
// window, the stream is treated as "WebSocket closed but no clean exit
// was observed" — which the cycle 10 contract maps to
// DaytonaSessionLogError (likely SIGKILL or trap aborted).
const STREAM_COMPLETION_GRACE_MS = 2_000;

type LogStreamRig = {
  readonly receive: Stream.Stream<string, DaytonaSessionLogError>;
  readonly stderr: Stream.Stream<string, DaytonaSessionLogError>;
  readonly shutdown: Effect.Effect<void>;
  readonly errorRef: Ref.Ref<Option.Option<DaytonaSessionLogError>>;
  readonly driverFiber: Fiber.RuntimeFiber<void, never>;
};

const buildLogStreams = (
  sandbox: Sandbox,
  sessionId: string,
  commandId: string,
  exitDeferred: Deferred.Deferred<
    DaytonaSessionExitInfo,
    DaytonaSessionNotFoundError | DaytonaSessionOpError
  >,
): Effect.Effect<LogStreamRig, never, Scope.Scope> =>
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

    const shutdown = Effect.all(
      [Queue.shutdown(stdoutQueue), Queue.shutdown(stderrQueue), Queue.shutdown(dropQueue)],
      { concurrency: "unbounded", discard: true },
    );

    const setLogError = (err: DaytonaSessionLogError) =>
      Effect.all(
        [
          Ref.set(errorRef, Option.some(err)),
          Deferred.fail(
            exitDeferred,
            new DaytonaSessionOpError({
              sessionId,
              operation: "waitExit",
              reason: `stream completed without observing exit code: ${err.reason}`,
            }),
          ).pipe(Effect.ignore),
        ],
        { concurrency: "unbounded", discard: true },
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
      Effect.matchEffect({
        // SDK's streaming Promise rejected — WebSocket-level error.
        onFailure: setLogError,
        // SDK's streaming Promise resolved cleanly. Wait briefly for the
        // watcher to observe the exit-file (clean exit ⇒ Deferred succeeds).
        // If the watcher hasn't observed within the grace window, treat as
        // a non-clean termination (e.g., SIGKILL — trap couldn't fire).
        onSuccess: () =>
          Deferred.await(exitDeferred).pipe(
            Effect.timeoutFail({
              duration: `${STREAM_COMPLETION_GRACE_MS} millis`,
              onTimeout: () =>
                new DaytonaSessionLogError({
                  sessionId,
                  commandId,
                  reason: `stream WebSocket closed but exit-code file not observed within ${STREAM_COMPLETION_GRACE_MS}ms (likely SIGKILL or trap aborted)`,
                }),
            }),
            Effect.matchEffect({
              onFailure: (err) =>
                err instanceof DaytonaSessionLogError
                  ? setLogError(err)
                  : setLogError(
                      new DaytonaSessionLogError({
                        sessionId,
                        commandId,
                        reason: `waitExit failed during stream-completion grace: ${err.reason}`,
                      }),
                    ),
              onSuccess: () => Effect.void,
            }),
          ),
      }),
      Effect.ensuring(shutdown),
      Effect.withSpan("DaytonaSession.streamLogs"),
    );

    const driverFiber = yield* Effect.forkScoped(driver);

    const checkError = Stream.fromEffect(
      Ref.get(errorRef).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Effect.fail })),
      ),
    ).pipe(Stream.drain);

    const receive = Stream.fromQueue(stdoutQueue).pipe(Stream.concat(checkError));
    const stderr = Stream.fromQueue(stderrQueue).pipe(Stream.concat(checkError));

    return { receive, stderr, shutdown, errorRef, driverFiber };
  });

// Exit detection workaround for the OSS Daytona test stack. Two SDK
// behaviors force the design here:
//
//   1. process.getSessionCommand never populates Command.exitCode for
//      runAsync sessions — it only ever returns { id, command }.
//   2. process.getSessionCommandLogs's Promise does not resolve when the
//      command exits naturally; it stays open until the session is deleted
//      (or the WebSocket errors out). Stream completion can therefore not
//      be derived from the SDK's resolution.
//
// Workaround: every start()'s user command is wrapped with a shell EXIT
// trap that writes the exit code to /tmp/<sessionId>-exit. A scope-bound
// "exit watcher" fork polls that file via sandbox.process.executeCommand
// every WAIT_EXIT_POLL_DELAY_MS *forever* — the consumer's scope governs
// lifetime, not a wall-clock deadline. On observed exit the watcher
// resolves a shared Deferred AND interrupts the streaming fork AND shuts
// down the stdout/stderr queues — driving deterministic receive-stream
// completion regardless of whether the SDK's WebSocket has closed yet.
// waitExit is a thin wrapper around Deferred.await.
//
// Backport-worthy: production Daytona Cloud may populate Command.exitCode
// or close the streaming WebSocket on command exit. If it does, this
// wrapper + file-poll can be retired (or downgraded to OSS-only).
const WAIT_EXIT_POLL_DELAY_MS = 200;

const exitFilePath = (sessionId: string): string => `/tmp/${sessionId}-exit`;
const pidFilePath = (sessionId: string): string => `/tmp/${sessionId}-pid`;

// The session shell does not auto-exit when a runAsync command's body
// finishes — it stays open waiting for more session input until an explicit
// `exit`. We capture the user command's exit code into __SWYRD_RC, sleep
// briefly so the SDK's WebSocket has time to flush any final stdout/stderr
// chunks, then exit explicitly so the EXIT trap fires and the exit-code
// file gets written. If the user's command runs `exit N` itself, the shell
// exits before reaching the sleep+exit lines and the trap still captures N.
//
// We also write the wrapper bash's PID to /tmp/<sessionId>-pid at startup
// so the SIGKILL detector can distinguish "wrapper still alive" from
// "wrapper killed before trap fired" without relying on a wall-clock
// deadline. The trap removes the PID file on clean exit so the absence
// of the PID file (without a corresponding exit file) is a reliable
// SIGKILL signal.
const wrapCommandWithExitTrap = (sessionId: string, command: string): string =>
  [
    `echo $$ > ${pidFilePath(sessionId)}`,
    `trap 'echo $? > ${exitFilePath(sessionId)}; rm -f ${pidFilePath(sessionId)}' EXIT`,
    command,
    "__SWYRD_RC=$?",
    "sleep 0.1",
    "exit $__SWYRD_RC",
  ].join("\n");

const readExitFile = (
  sandbox: Sandbox,
  sessionId: string,
): Effect.Effect<
  Option.Option<DaytonaSessionExitInfo>,
  DaytonaSessionNotFoundError | DaytonaSessionOpError
> => {
  const exitFile = exitFilePath(sessionId);
  return Effect.tryPromise({
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
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode !== 0) {
        return Effect.succeed(Option.none<DaytonaSessionExitInfo>());
      }
      const trimmed = (result.result ?? "").trim();
      if (trimmed.length === 0) {
        return Effect.succeed(Option.none<DaytonaSessionExitInfo>());
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(parsed)) {
        return Effect.fail(
          new DaytonaSessionOpError({
            sessionId,
            operation: "waitExit",
            reason: `exit-file ${exitFile} contained non-numeric value: ${trimmed}`,
          }),
        );
      }
      return Effect.succeed(Option.some({ exitCode: parsed }));
    }),
  );
};

// pollExitOrSigkill polls the exit-code file forever, but ALSO checks the
// wrapper PID file on each iteration. If the PID file is gone AND the
// exit file is also gone, the wrapper was killed before its trap could
// fire (SIGKILL or equivalent), and we surface that as a typed failure
// instead of polling indefinitely. Lifetime is governed by the consumer's
// scope, not a wall-clock deadline — codex app-server turns can run for
// minutes.
const pollExitOrSigkill = (
  sandbox: Sandbox,
  sessionId: string,
): Effect.Effect<DaytonaSessionExitInfo, DaytonaSessionNotFoundError | DaytonaSessionOpError> => {
  const exitFile = exitFilePath(sessionId);
  const pidFile = pidFilePath(sessionId);

  // Probe: returns exit code 0 if either (a) the exit-code file exists
  // (clean exit imminent — readExitFile catches it on the next tick) or
  // (b) the wrapper PID is still alive AND not a zombie. Returns non-zero
  // if both conditions fail, which means the wrapper died before its
  // trap could run (SIGKILL or equivalent). Uses `/proc/<pid>/exe`
  // existence rather than `kill -0` because `kill -0` returns success
  // for zombie processes (the PID exists in the process table even
  // though the program is dead); the `exe` symlink is removed when the
  // process actually exits, so its presence is the cleaner liveness test.
  const probeCommand = `test -e ${exitFile} || { pid=$(cat ${pidFile} 2>/dev/null) && [ -n "$pid" ] && [ -e /proc/$pid/exe ]; }`;

  return Effect.gen(function* () {
    let missingSince: number | undefined;
    while (true) {
      const found = yield* readExitFile(sandbox, sessionId);
      if (Option.isSome(found)) {
        return found.value;
      }
      // Check whether the wrapper PID file is still present. If the trap
      // ran cleanly the exit file is written first (we'd have caught it
      // above), then the PID file is removed. If the wrapper was killed,
      // the PID file disappears via the sandbox's normal /proc cleanup
      // (the file persists but the PID is gone) — we additionally probe
      // /proc/<pid> via `kill -0`. To keep the probe simple, we use the
      // file-existence test and accept that a brief race window between
      // trap-write-exit and trap-rm-pid produces no false positive (both
      // files coexist for a few microseconds; the next poll observes
      // exit and returns success).
      const probe = yield* Effect.tryPromise({
        try: () => sandbox.process.executeCommand(probeCommand),
        catch: (error) => {
          if (isDaytonaNotFound(error)) {
            return new DaytonaSessionNotFoundError({
              sessionId,
              operation: "sigkillProbe",
              reason: describeUnknown(error),
            });
          }
          return new DaytonaSessionOpError({
            sessionId,
            operation: "sigkillProbe",
            reason: describeUnknown(error),
          });
        },
      });

      if (probe.exitCode !== 0) {
        missingSince ??= Date.now();
        if (Date.now() - missingSince < STREAM_COMPLETION_GRACE_MS) {
          yield* Effect.sleep(`${WAIT_EXIT_POLL_DELAY_MS} millis`);
          continue;
        }
        // Both files gone — wrapper killed before trap could fire.
        return yield* Effect.fail(
          new DaytonaSessionOpError({
            sessionId,
            operation: "waitExit",
            reason: "wrapper process disappeared before EXIT trap fired (likely SIGKILL)",
          }),
        );
      }

      missingSince = undefined;
      yield* Effect.sleep(`${WAIT_EXIT_POLL_DELAY_MS} millis`);
    }
  }).pipe(Effect.withSpan("DaytonaSession.exitWatcher"));
};

const start = (
  client: Daytona,
  handle: SandboxHandle,
  command: string,
): Effect.Effect<ProtocolStream, DaytonaSessionStartError, Scope.Scope> =>
  Effect.gen(function* () {
    // Generate sessionId before any SDK call so error paths always carry a
    // real id (no "n/a" magic string in DaytonaSessionOpError).
    const sessionId = generateSessionId();
    const sandbox = yield* getSandboxForSession(client, handle.id, sessionId);

    const closeOnce = yield* Ref.make(false);
    const close = Ref.getAndSet(closeOnce, true).pipe(
      Effect.flatMap((alreadyClosed) =>
        alreadyClosed ? Effect.void : releaseSession(sandbox, sessionId),
      ),
      Effect.withSpan("DaytonaSession.close"),
    );

    yield* Effect.acquireRelease(createSession(sandbox, handle.id, sessionId), () => close);

    const wrappedCommand = wrapCommandWithExitTrap(sessionId, command);
    const commandId = yield* executeSessionCommand(sandbox, sessionId, wrappedCommand);
    yield* waitForSessionInputPipe(sandbox, sessionId, commandId);

    const exitDeferred = yield* Deferred.make<
      DaytonaSessionExitInfo,
      DaytonaSessionNotFoundError | DaytonaSessionOpError
    >();

    const rig = yield* buildLogStreams(sandbox, sessionId, commandId, exitDeferred);

    yield* Effect.forkScoped(
      pollExitOrSigkill(sandbox, sessionId).pipe(
        Effect.matchCauseEffect({
          onSuccess: (info) =>
            Deferred.succeed(exitDeferred, info).pipe(
              Effect.zipRight(Fiber.interrupt(rig.driverFiber)),
              Effect.zipRight(rig.shutdown),
            ),
          // Watcher failed (SIGKILL detected or SDK error). Mirror to the
          // receive stream so consumers observe a typed failure instead of
          // a clean termination; the driver may still be hanging on the
          // SDK's streaming Promise, so we also interrupt it explicitly.
          onFailure: (cause) =>
            Effect.all(
              [
                Ref.set(
                  rig.errorRef,
                  Option.some(
                    new DaytonaSessionLogError({
                      sessionId,
                      commandId,
                      reason: "exit watcher failed before observing exit",
                    }),
                  ),
                ),
                Deferred.failCause(exitDeferred, cause).pipe(Effect.ignore),
                Fiber.interrupt(rig.driverFiber),
                rig.shutdown,
              ],
              { concurrency: "unbounded", discard: true },
            ),
        }),
      ),
    );

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

    const waitExit = Deferred.await(exitDeferred).pipe(Effect.withSpan("DaytonaSession.waitExit"));

    const stream: ProtocolStream = {
      sessionId,
      commandId,
      receive: rig.receive,
      stderr: rig.stderr,
      send,
      waitExit,
      close,
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
