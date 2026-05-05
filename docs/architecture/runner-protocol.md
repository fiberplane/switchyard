# Runner Protocol

Status: Active. Scope: **the v0 codex app-server JSON-RPC client contract** as it actually
shipped in commits `a0fb01a` (session) → `9d6ef4d` (turn) → `df45540` (service). This doc
captures the protocol-shape facts and design choices that diverged from the original ticket
sketches (`SWYRD-fdtjbcdo`, `SWYRD-jdqmyulm`, `SWYRD-lxycsske`) once real `codex app-server
0.128.0` was driving the wire.

The runner module is a **stream consumer** — it accepts a `ProtocolStream { send, receive }`
and drives JSON-RPC over it. It does not spawn `codex app-server`, does not own a sandbox
lifecycle, does not write transcripts.

Cross-links:

- Umbrella spec: [`### Worker Protocol`](../experiments/2026-05-04-symphony-daytona-vertical-slice.md)
  (lines 511–543) — high-level protocol shape.
- ADR: [`0001-symphony-deviations.md`](./0001-symphony-deviations.md) — D5 (no auto-retry,
  failures bubble to caller).
- Future considerations under [`SWYRD-uouprnfv`](https://app.fp.dev/issues/SWYRD-uouprnfv):
  configurable initialize capabilities (`SWYRD-ohvkezee`), reconsider streaming-transcript
  shape (`SWYRD-aaytmsfz`), split `LocalCodexUnavailableError` into typed errors
  (`SWYRD-dptkgxlj`), GH-issue tracker for the codex-rs ts-rs annotation drift
  (`SWYRD-nlqhtaub`).

## Approval reply shapes (three, not one)

The original ticket bodies and the umbrella spec at line 220 said all five auto-approval
methods reply with `{ decision: "approved" }`. The implementer hit three distinct reply
shapes against real codex 0.128.0. The single source of truth is `approvalResponseFor` in
`runner/turn.ts` (exported and reused by the protocol-drift canary so production and the
canary share one table).

| Server-initiated method                              | Reply shape                                     | Notes                                                        |
| ---------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `applyPatchApproval`                                 | `{ decision: "approved" }`                      | Legacy approval method                                       |
| `execCommandApproval`                                | `{ decision: "approved" }`                      | Legacy approval method                                       |
| `item/fileChange/requestApproval`                    | `{ decision: "accept" }`                        | v2 — verified against `approval-roundtrip.jsonl`             |
| `item/commandExecution/requestApproval`              | `{ decision: "accept" }`                        | v2                                                           |
| `item/permissions/requestApproval`                   | `{ permissions, scope: "turn" }`                | Echo `network` + `fileSystem` from the request when non-null; other keys not forwarded |

The reply id is **the server's id**. Server-initiated requests carry their own id namespace
that can collide numerically with the client's monotonic allocator (both can be `1`); the
session's `isProtocolResponse` predicate (`session.ts`) disambiguates by frame shape — only
messages with `id` plus `result|error` are responses, so server-initiated requests (with `id`
plus `method` and no result/error) flow to the `notifications` stream. Production turn does
NOT register a pending entry on the session for the auto-approval reply — it is
fire-and-forget.

## Terminal notifications

Four notification methods can terminate a turn (`TERMINAL_METHODS` set in `runner/turn.ts`):

- `turn/completed` — canonical success, but only when `params.turn.status` is not `"failed"`
  or `"interrupted"`. `runTurn` resolves `{ kind: "completed", result, events }`. The
  classifier is permissive — any status not literally `"failed"`/`"interrupted"` (including
  `null`, `undefined`, or a future codex value) maps to success. Add explicit handling if
  codex introduces a new failure-state value.
- `turn/completed` with `params.turn.status === "failed"` — terminal failure; the turn
  watcher fails its `Deferred` with `RunnerTurnFailedError`, and `runTurn` maps it to
  `{ kind: "failed", reason, events }`.
- `turn/completed` with `params.turn.status === "interrupted"` — terminal cancellation;
  mapped to `{ kind: "cancelled", reason, events }`.
- `turn/failed` — same as the failed-status branch but via a distinct method name.
- `turn/cancelled` — same as interrupted-status but via a distinct method name.
- `item/tool/requestUserInput` — terminal-for-this-turn input request; mapped to
  `{ kind: "input-required", prompt, events }`. The orchestrator decides whether to fail
  the issue, prompt a human, or schedule a continuation turn (continuation deferred per ADR
  D5; tracked in `SWYRD-clnybkgo`).

The reason string follows a fallback chain: `params.turn.error` → `params.error` →
`params.message` → `params.reason` → the method name. See the `terminalResult` switch in
`runner/turn.ts`.

`TurnOutcome` (the public discriminated union returned by `runTurn`) has exactly these four
variants: `completed | failed | cancelled | input-required`. Every variant carries
`events: ReadonlyArray<RunnerNotification>` — see "Notifications stream is single-consumer"
below.

## Initialize capabilities — `experimentalApi: false`

The generated TypeScript binding at `src/runner/protocol/InitializeCapabilities.ts` requires
`experimentalApi: boolean`. Real codex 0.128.0 actually accepts:

- `capabilities: {}` (the shape used by `playgrounds/symphony-daytona-playground/src/codex-driver.cjs`
  and the captured fixtures), and
- `capabilities` omitted entirely (per the codex
  [README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md): _"If
  `capabilities` is omitted, `experimentalApi` is treated as `false`."_).

Switchyard sends the explicit default `{ experimentalApi: false }` so the call site can be
typed `(): InitializeParams` instead of the original `(): unknown` workaround. Functionally
equivalent to `{}`; more bytes on the wire, but matches the generated bindings without a cast.

The drift between the generated type and the documented server behavior is a ts-rs annotation
issue in codex-rs (the field needs `#[serde(default)]` + `#[ts(optional)]`). Tracked under
`SWYRD-nlqhtaub`. Configurable capabilities (per-orchestrator override) deferred to
`SWYRD-ohvkezee`.

## Notifications stream is single-consumer

Session exposes `notifications: Stream.fromQueue(notificationsQueue)` — a single-consumer
queue. The turn watcher in `runner/turn.ts` is the queue's consumer; it re-buffers each
notification into its own `events` queue (so `startTurn` can return `{ events, completed }`
both backed by the same upstream stream of frames).

The constraint propagates upward: because `session.notifications` has only one consumer (the
turn watcher), the runner service can't compose a separate `transcript: Stream<...>`
alongside `outcome` the way the original `SWYRD-lxycsske` ticket sketch envisioned. Instead,
`runTurn` collects events with `Stream.runCollect` into the scope (forked), then attaches the
buffered chunk to every `TurnOutcome` variant as `events: ReadonlyArray<RunnerNotification>`.

This is the v0 contract. Trade-offs the orchestrator-service consumer should know:

- **Memory bound**: a 600s turn buffers all notifications in memory before the orchestrator
  can write `transcript.jsonl`. No incremental streaming write.
- **No tee**: the orchestrator can't tee notifications to a logger and a transcript file
  simultaneously — it gets one snapshot at terminal time.
- **Mid-turn observability**: requires wrapping `runTurn` (e.g., via `Effect.withSpan`) at
  the orchestrator layer, since the runner doesn't expose mid-turn progress.

A reconsideration of this shape (multi-consumer `PubSub`, sink-style API, or explicit memory
bound) is captured in `SWYRD-aaytmsfz`.

## Public turn API

The runner exposes `startTurn({ session, prompt, cwd, timeoutMs }) → { events, completed }`
in `runner/turn.ts`. The original ticket sketch named it `makeTurn(session, stream, params,
options) → { outcome, transcript }`. The shipped shape drops the redundant `stream` parameter
(turn uses `session.sendNotificationResponse` for approval replies) and renames `transcript →
events` / `outcome → completed` to match the implementation: `events` is a finite stream
that closes on terminal, `completed` is an `Effect` that resolves with the terminal payload
or fails with a turn-domain tagged error.

The runner-service layer (`runner/service.ts`) is the public surface for orchestrator
consumers — it composes `makeSession` + `startTurn` and maps turn-domain failures into the
`TurnOutcome` discriminated union.

## Validation policy

Generated codex bindings are trusted as-is per parent ticket `SWYRD-klgfjflj`. The session
performs **only minimal structural validation** for the one field actually consumed
downstream: `getThreadId` checks that `result.thread.id` is a non-empty string, raising
`RunnerProtocolError` otherwise. Other fields of the initialize / thread/start responses are
not validated — if the protocol drifts in shape on those fields, the integration canary
(`apps/symphony-orchestrator/test/runner/service.local-codex.test.ts`) is the signal.

Earlier session iterations carried full structural assertions over both responses (~17 fields
on `thread/start`); commit `3a2d116` removed them once they were identified as
validators-for-tests rather than validators-for-protocol.
