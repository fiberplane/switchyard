import { Chunk, Effect, Stream } from "effect";

import {
  DaytonaSession,
  type DaytonaSessionStartError,
  type ProtocolStream,
} from "../../../src/daytona/daytona.session.js";
import {
  DaytonaSessionLogError,
  type DaytonaSessionInputError,
  type DaytonaSessionNotFoundError,
  type DaytonaSessionOpError,
} from "../../../src/daytona/errors.js";
import type { SandboxHandle } from "../../../src/daytona/models.js";

// Wraps DaytonaSession.start in Effect.scoped semantics so the body runs
// with the session alive and the scope finalizer (deleteSession) runs even
// when the body fails. The orchestrator-service-leaf and runner-leaf
// integration tests are expected to compose this same primitive when
// wrapping ProtocolStream for codex app-server, so the helper lives here
// (test-helpers/) rather than test-locally.
export const withSession = <A, E>(
  handle: SandboxHandle,
  command: string,
  body: (stream: ProtocolStream) => Effect.Effect<A, E, never>,
): Effect.Effect<A, DaytonaSessionStartError | E, DaytonaSession> =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* DaytonaSession;
      const stream = yield* session.start(handle, command);
      return yield* body(stream);
    }),
  );

// Drains a Stream into a Chunk with a deadline so streaming assertions
// never block the suite indefinitely. Default 5000ms matches the spike's
// per-probe budget; cancellation / exit cycles override per-call.
export const collectFor = <E>(
  stream: Stream.Stream<string, E>,
  deadlineMs: number = 5_000,
): Effect.Effect<Chunk.Chunk<string>, E | DaytonaSessionLogError> =>
  Stream.runCollect(stream).pipe(
    Effect.timeoutFail({
      duration: `${deadlineMs} millis`,
      onTimeout: () =>
        new DaytonaSessionLogError({
          sessionId: "n/a",
          commandId: "n/a",
          reason: `collectFor deadline exceeded after ${deadlineMs}ms`,
        }),
    }),
  );

// Polls a synchronous predicate until it returns true or the deadline
// expires. Useful for "wait for chunk X to appear in a buffer" patterns
// that recur across the cycle 5/10/11/14 tests.
export const waitForCondition = (
  predicate: () => boolean,
  deadlineMs: number,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const start = Date.now();
    while (!predicate() && Date.now() - start < deadlineMs) {
      yield* Effect.sleep("50 millis");
    }
    return predicate();
  });

// Forks a stream-into-buffer collector that pushes every chunk into the
// provided array. Returns the fiber so callers can interrupt or join.
// Used by tests that need to poll a buffer for specific markers (e.g.,
// PID lines from the bash echo loop, "ready" sentinels).
export const forkBufferReceive = <E extends DaytonaSessionLogError>(
  stream: Stream.Stream<string, E>,
  buffer: string[],
) =>
  Effect.forkScoped(
    stream.pipe(
      Stream.tap((chunk) =>
        Effect.sync(() => {
          buffer.push(chunk);
        }),
      ),
      Stream.runDrain,
      Effect.ignore,
    ),
  );

export type { DaytonaSessionInputError, DaytonaSessionNotFoundError, DaytonaSessionOpError };
