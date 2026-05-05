# Daytona session API — bidirectional stdio for `codex app-server`

Date: 2026-05-05
Spike issue: [`SWYRD-wnzgxnsi`](fp://SWYRD-wnzgxnsi)
Status: Resolved — **native SDK stdin works; use it.**

## Question

The vertical-slice spec
(`docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md`) plans for the orchestrator
running on the host to drive `codex app-server` running inside the Daytona sandbox over a
bidirectional stdio stream — the runner module is being designed as a `ProtocolStream { send,
receive }` consumer.

The smoke playground at `playgrounds/symphony-daytona-playground/src/smoke.ts` only used the
read-side of `process.createSession` / `process.executeSessionCommand` (kickoff +
`getSessionCommandLogs` callback subscriber). The spike asked whether the SDK actually exposes a
write-to-stdin path for a long-running session command, or whether the orchestrator would have to
fall back to an SSH stdio tunnel, an in-sandbox TCP proxy, or pushing the protocol client back
into the sandbox like the existing app-server smoke does.

## Answer

**Native SDK stdin works — use it.** The `@daytona/sdk` Process surface (verified against
`@daytona/sdk@0.171.0`) provides a write-to-stdin endpoint paired with a follow-streaming
read endpoint for the same long-running session command:

| Direction            | SDK call                                                                  | Transport                  |
| -------------------- | ------------------------------------------------------------------------- | -------------------------- |
| Launch peer          | `process.executeSessionCommand(sessionId, { command, runAsync: true })`   | HTTP                       |
| Write to stdin       | `process.sendSessionCommandInput(sessionId, commandId, data)`             | HTTP (`POST … /input`)     |
| Stream stdout/stderr | `process.getSessionCommandLogs(sessionId, commandId, onStdout, onStderr)` | WebSocket (`?follow=true`) |

The toolbox-api-client surface confirms the route — `ProcessApi.sendInput` posts a
`SessionSendInputRequest` and `getSessionCommandLogs` returns a multiplexed WebSocket the SDK
demuxes into `onStdout` / `onStderr` callbacks.

A separate WebSocket-based PTY path (`process.createPty()` returning a `PtyHandle` with
`sendInput` + `onData`) also exists but adds terminal line discipline (echo, signals, `\r\n`
translation), which is undesirable for `codex app-server`'s binary JSON-RPC stdio. We use the
session-command path for the orchestrator and reserve PTY for any future interactive-shell
needs.

## Evidence

`playgrounds/symphony-daytona-playground/src/spike-stdio.ts` — runnable spike that:

1. Creates a sandbox from the `symphony-codex-bun` snapshot.
2. Starts a session and launches a long-lived `bash` `read` loop with `runAsync: true`.
3. Subscribes to streaming logs via `getSessionCommandLogs(onStdout, onStderr)`.
4. Writes four distinct messages (including spaces, unicode, and shell-special characters) to
   stdin via `sendSessionCommandInput` and asserts each is echoed back inside 5 s.
5. Sends a sentinel line, waits for the peer to exit cleanly, and verifies `exitCode === 0`.

Run:

```bash
bun run --cwd playgrounds/symphony-daytona-playground spike:stdio
```

Artifacts (`playgrounds/symphony-daytona-playground/artifacts/spike-stdio-<timestamp>/`):

- `manifest.json` — outcome, per-probe round-trip latency, chunk counts.
- `stdout.log`, `stderr.log` — captured stream chunks with timestamps.

## Implication for the runner / orchestrator split

The runner module (`SWYRD-` runner sub-leaves) is unchanged: it stays a `ProtocolStream`
consumer and doesn't care where bytes come from. Its tests can keep using a local-spawn
`codex app-server` and a node `child_process` adapter.

The orchestrator service leaf gets a concrete adapter shape:

- Wrap the daytona session command pair into a `ProtocolStream`:
  - `send(bytes)` → `sandbox.process.sendSessionCommandInput(sessionId, cmdId, bytes)`
  - `receive` is an Effect `Stream` driven by the `onStdout` callback.
- No additional dependencies (no SSH client, no in-sandbox proxy binary). The Daytona snapshot
  stays as-is.

## Out of scope for this spike

- No production wiring lands here — this spike is information only. The orchestrator service
  leaf will own the `ProtocolStream` adapter.
- No performance benchmarking. Per-probe round-trip latency is captured for sanity but is not a
  load test.
- No multi-turn / continuation flows (`SWYRD-clnybkgo`).
