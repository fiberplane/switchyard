# Daytona Streaming Session

Status: Active. Scope: **`DaytonaSession` Effect service surface and the OSS-Daytona
exit-detection workaround** that makes its `waitExit` / receive-stream-completion contracts
work in the local test stack. The `DaytonaAdapter` boundary (config, sandbox lifecycle,
file transfer, sync exec) is documented inline in `daytona.adapter.ts`; this doc is only
about the streaming-session surface added by `SWYRD-omdkfnbz`.

This doc links UP to the umbrella spec's
[`## Daytona Execution Strategy → Worker Protocol`](../experiments/2026-05-04-symphony-daytona-vertical-slice.md)
section and DOWN to the source files that implement it.

Cross-links:

- Umbrella spec: [`docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md`](../experiments/2026-05-04-symphony-daytona-vertical-slice.md)
  (Daytona Execution Strategy → Worker Protocol).
- Bidirectional-stdio spike: [`docs/experiments/2026-05-05-daytona-bidirectional-stdio.md`](../experiments/2026-05-05-daytona-bidirectional-stdio.md)
  — the spike that proved the SDK's `sendSessionCommandInput` round-trip and motivated the
  paired `ProtocolStream` shape.
- ADR: [`0001-symphony-deviations.md`](./0001-symphony-deviations.md) — D6 / D7 (sandbox
  lifecycle and artifact return; the streaming session is the transport).

## Surface

`DaytonaSession.start(handle, command)` returns a `ProtocolStream` paired around one
long-running `executeSessionCommand(runAsync: true)`:

```ts
type ProtocolStream = {
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
  readonly close: Effect.Effect<void>;
};
```

`start` requires `Scope.Scope` so consumers must use `Effect.scoped` (or compose via the
`withSession` test helper). The session lifecycle is bound to the scope: `createSession` is
acquired with `Effect.acquireRelease`, and the release calls `close` (which itself
delegates to `deleteSession`, idempotent via a `Ref<boolean>`).

**Frame type is `string`.** Codex app-server JSON-RPC is line-delimited UTF-8 text; the
SDK accepts `string` only on `sendSessionCommandInput` and emits `string` on
`getSessionCommandLogs`. A future `Uint8Array` overload of `start` is left as a separate
follow-up; do not lift `string` out of the contract preemptively.

## Why the wrapper exists (SDK limitations on the OSS test stack)

Two `@daytona/sdk@0.171.0` behaviors observed against the local Daytona OSS test stack
forced a pivot away from the ticket's originally-planned exit-detection design:

1. **`process.getSessionCommand` does not populate `Command.exitCode`** for runAsync
   sessions. The response shape is `{ id, command }` — the field documented in the OpenAPI
   model never appears in real traffic.
2. **`process.getSessionCommandLogs`'s Promise stays pending forever** when the user
   command exits naturally OR is SIGKILLed. It does not resolve, does not reject. The only
   thing that closes the WebSocket is `deleteSession`.

Consequences:

- The ticket's planned `waitExit` (poll `getSessionCommand` until `exitCode != null`) cannot
  ever return — the field is permanently absent.
- The ticket's planned receive-stream completion contract (derive completion from the SDK's
  streaming Promise resolution) gives the consumer no usable signal — the Promise stays
  pending until session deletion, which the consumer typically does not do until _after_
  draining the stream, producing a deadlock.

The workaround:

- Every user command is **wrapped with a shell `EXIT` trap** that writes the exit status to
  a sandbox-side file and writes the wrapper bash's PID to a sibling file:

  ```sh
  echo $$ > /tmp/<sessionId>-pid
  trap 'echo $? > /tmp/<sessionId>-exit; rm -f /tmp/<sessionId>-pid' EXIT
  <user command>
  __SWYRD_RC=$?
  sleep 0.1
  exit $__SWYRD_RC
  ```

  The trailing explicit `exit` is required because the session shell does not auto-exit when
  a runAsync body finishes — it stays open waiting for more session input. The pre-exit
  `sleep 0.1` gives the SDK's WebSocket time to flush any final stdout/stderr chunks before
  the session terminates and the trap fires. If the user command runs `exit N` itself, the
  shell exits before reaching the sleep+exit lines and the trap still captures N.

- A scope-bound **exit watcher** fork polls those two files via direct
  `sandbox.process.executeCommand` (the synchronous adapter call, not the streaming one):

  ```sh
  test -e /tmp/<sessionId>-exit \
    || { pid=$(cat /tmp/<sessionId>-pid 2>/dev/null) \
         && [ -n "$pid" ] && [ -e /proc/$pid/exe ]; }
  ```

  Returns 0 if either (a) the exit-code file exists (clean exit imminent — `readExitFile`
  catches it on the next tick) or (b) the wrapper PID is alive AND not a zombie. Returns
  non-zero if both conditions fail, which means the wrapper died before its trap could run
  (SIGKILL or equivalent).

- The watcher uses `/proc/<pid>/exe` existence rather than `kill -0` because `kill -0`
  returns success for zombie processes (the PID exists in the process table even though the
  program is dead); the `exe` symlink is removed when the process actually exits, so its
  presence is the cleaner liveness test.

- On observed exit (file appears) the watcher resolves a shared `Deferred`, interrupts the
  streaming-driver fiber, and shuts down the stdout/stderr/drop queues. On observed SIGKILL
  (probe fails) it sets the `errorRef` to `DaytonaSessionLogError` AND fails the same
  `Deferred` AND interrupts the driver AND shuts down queues. Either path drives
  deterministic `Stream.runCollect(receive)` completion regardless of whether the SDK's
  WebSocket has closed yet.

- `waitExit` is a thin `Deferred.await` wrapper, so it resolves when the watcher fires.

The watcher does **not** have a wall-clock deadline. Lifetime is governed by the
consumer's `Scope`. This matters because the only intended consumer is `codex app-server`
turns, which can run for minutes; an arbitrary deadline would silently terminate them.

## Receive-stream completion contract

`Stream.runCollect(receive)` resolves cleanly when:

- The exit-code file is observed (the watcher resolves the `Deferred`), OR
- The consumer's scope is interrupted (the queues shut down via the scope finalizer; clean
  termination semantics — Effect's runtime signals interruption to the caller separately).

`Stream.runCollect(receive)` fails with `DaytonaSessionLogError` when:

- The SDK's streaming Promise rejects (WebSocket-level error close), OR
- The SDK's streaming Promise resolves cleanly but the watcher does not observe the exit
  file within `STREAM_COMPLETION_GRACE_MS` (currently 2000ms; "WebSocket closed but no
  clean exit was observed"), OR
- The watcher's SIGKILL probe fires (wrapper PID is dead AND no exit file).

Consumers that want to differentiate "command exited 0" from "command exited non-zero"
should pair `receive` with `waitExit`; the receive stream itself does not propagate exit
codes.

## Backpressure

`getSessionCommandLogs`'s callbacks are synchronous (`(chunk: string) => void`). Bridging
into Effect requires a non-blocking offer because:

1. `Effect.runSync(Queue.offer(...))` on a full bounded queue throws `AsyncFiberException`
   into the WebSocket fiber and tears down the stream. **Do not use it from the SDK
   callback.**
2. `Queue.offerAll` blocks the fiber, but the SDK's WebSocket reader has no contract that
   pauses if the callback blocks — the SDK may keep buffering internally regardless.

The bridge therefore uses `Queue.unsafeOffer` (synchronous, non-blocking, returns `false`
when at capacity). On `false`, the chunk is dropped and a drop event is enqueued into a
separate unbounded `dropQueue`; a scope-bound logger fiber drains that queue into
`Effect.logWarning` so operators can observe drops in tracing without blocking the SDK
callback. **The contract is orchestrator-heap protection only** — chunks may be dropped
when the consumer falls behind; SDK-internal buffering is out of our control.

The bounded capacity is currently 1024, sized to absorb a typical codex turn's burst of
JSON-RPC frames without dropping. The cycle 13 burst test verifies a 1000-line emission
round-trips at this capacity. Real-world tuning under integration is tracked as
`SWYRD-flvidfql` (queue-full drop-path coverage with a runtime override).

## Error taxonomy

Six `Data.TaggedError` classes plus the existing `DaytonaSandboxNotFoundError`:

| Error                         | When it fires                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DaytonaSessionCreateError`   | `process.createSession` failed (non-404).                                                                                                              |
| `DaytonaSessionExecError`     | `process.executeSessionCommand` failed (non-404), or response decode failed.                                                                           |
| `DaytonaSessionLogError`      | Streaming WebSocket closed with error, or SIGKILL detected, or grace timeout expired.                                                                  |
| `DaytonaSessionInputError`    | `process.sendSessionCommandInput` failed (non-404).                                                                                                    |
| `DaytonaSessionNotFoundError` | Session-level 404 from any of the four session-targeted SDK calls.                                                                                     |
| `DaytonaSessionOpError`       | Boundary errors that aren't a single SDK call (`getSandbox` failure, exit-file decode, SIGKILL surfaced from `pollExitOrSigkill`, generic op failure). |
| `DaytonaSandboxNotFoundError` | Sandbox-level 404 (the sandbox itself was deleted). Reused from `daytona.adapter.ts`.                                                                  |

The session-level NotFound (`DaytonaSessionNotFoundError`) is distinct from the
sandbox-level NotFound (`DaytonaSandboxNotFoundError`) so consumers can route to
recreate-sandbox logic vs. retry-session logic on different signals. SDK 404 detection
uses the shared `isDaytonaNotFound` predicate from `daytona-client.ts`.

## Span coverage

Every public op and every internal scope-bound fork wraps in `Effect.withSpan`:

- `DaytonaSession.start`
- `DaytonaSession.send`
- `DaytonaSession.waitExit`
- `DaytonaSession.close`
- `DaytonaSession.streamLogs` (driver fiber)
- `DaytonaSession.exitWatcher` (watcher fiber)

`EFFECT_TRACE=1` shows the full call tree on stdout. The spans pair with the structured
log annotations in the drop-queue logger (`sessionId`, `commandId`, `channel`,
`droppedBytes`, `queueCapacity`).

## Test-isolation pattern

Inherited from the gzszputs leaf — no new infrastructure. Test sandboxes use the same
`switchyard-test` Daytona stack on the `+30000` port range, the same `symphony-test-base`
snapshot, and the same `app=symphony-test` + `test_run_id` labels via
`buildTestSandboxSpec`. The session tests pass no caller labels beyond what
`buildTestSandboxSpec` supplies; cleanup via `deleteByTestRunId` (paginated, from gzszputs
commit `174b565`) covers cancellation cycles.

A small set of test-only helpers lives in
[`test/daytona/test-helpers/session-helpers.ts`](../../apps/symphony-orchestrator/test/daytona/test-helpers/session-helpers.ts):
`withSession` (Effect.scoped wrapper around `start`), `collectFor` (Stream.runCollect with
deadline), `waitForCondition` (poll predicate with deadline), `forkBufferReceive`. The
orchestrator-service leaf and the runner leaf are expected to compose these primitives
when wrapping `ProtocolStream` for codex app-server.

## Source bindings

`drift link`ed source files (managed via `drift.lock`):

- [`daytona.session.ts`](../../apps/symphony-orchestrator/src/daytona/daytona.session.ts) —
  the `DaytonaSession` Effect service, `DaytonaSessionLive` layer, `start` /
  `wrapCommandWithExitTrap` / `pollExitOrSigkill` / `buildLogStreams`. The exit-trap
  wrapper and SIGKILL probe live here.
- [`daytona-client.ts`](../../apps/symphony-orchestrator/src/daytona/daytona-client.ts) —
  shared `createDaytonaClient` / `describeUnknown` / `isDaytonaNotFound` /
  `isStateChangeInProgress` consumed by both `daytona.adapter.ts` and
  `daytona.session.ts` (extracted from the adapter so both consumers share one source of
  truth).
- [`session-models.ts`](../../apps/symphony-orchestrator/src/daytona/session-models.ts) —
  `DaytonaSessionExecuteResponseSchema` (the `{ cmdId }` schema decoded at the
  `executeSessionCommand` boundary).
- [`errors.ts`](../../apps/symphony-orchestrator/src/daytona/errors.ts) — the six new
  `Data.TaggedError` classes plus the existing sandbox-level errors.

## Backport-tracked decisions

These were locked in this leaf and are sibling-relevant for the runner and
orchestrator-service consumers:

1. **Frame type = `string`.** Future `Uint8Array` consumer = separate `start` overload.
2. **Bounded queue capacity = 1024**, drop-with-log on overflow. Configurable per-session
   if real-world drop rates demand tuning (`SWYRD-flvidfql`).
3. **`waitExit` cadence = 200ms fixed**, no wall-clock deadline. Consumer scope governs
   lifetime.
4. **Exit-trap wrapper is the OSS-Daytona workaround.** Production Daytona Cloud may
   behave differently; confirm before retiring.
5. **PID-file-based SIGKILL probe** uses `/proc/<pid>/exe`, not `kill -0` (zombie-safe).
   Linux-only; Daytona snapshots are Linux so this is fine.
6. **`ProtocolStream.close` is idempotent** (`Ref.getAndSet` pattern). Multiple calls are
   safe; the second call is `Effect.void`.
