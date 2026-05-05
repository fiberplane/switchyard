# Orchestrator Reconciliation

**Status:** Accepted (v1)
**Date:** 2026-05-05
**Source-of-truth ticket:** `SWYRD-osqltjnr` (orchestrator service)
**Drift-bound files (anchor-stamped):** `apps/symphony-orchestrator/src/orchestrator/service.ts` *(pending — file does not exist yet; bind on first commit of service.ts under `SWYRD-osqltjnr`)*

## Context

"Single-flight" in this document means **at most one in-flight `runOne` per tick**, the v1 lock from `WorkflowConfig.agent.maxConcurrentAgents = 1` (`apps/symphony-orchestrator/src/workflow/models.ts`). Concurrency > 1 is deferred (see "When this changes").

The umbrella spec's per-tick pseudocode (`docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md` `### Orchestrator Flow`) opens with:

```text
load workflow config
reconcile in-memory running set against tracker (if any tracker state is terminal, drop from running)
fetch fp candidates …
```

The "reconcile" step is left abstract. Two concrete shapes exist:

1. **Identity reconcile.** Trust the in-memory running set. Run no checks against fp at the top of each tick. v1 ships this.
2. **Tracker-authoritative reconcile.** Re-fetch each running entry's fp issue at tick start. If `status` has transitioned to `done` or out of `in-progress` via human action, drop the entry. Mid-flight reconciliation against external mutations.

This document records why v1 chooses (1), what the consequences are, and when (2) becomes load-bearing.

## Decision

**v1 reconcile is identity.** `OrchestratorService.runOneTick` does not re-validate running-set entries against fp at tick start. The running set is the orchestrator's single in-process source of truth for what's currently dispatched.

Rationale:

- **ADR D2** (`docs/architecture/0001-symphony-deviations.md`) makes in-memory state authoritative at runtime. fp is observed (eligibility scan), not consulted (claim verification).
- **ADR D3** locks single-orchestrator. The only writer to a running entry is the orchestrator process itself. There is no other writer for a tick-start reconcile to detect.
- **ADR D5** locks human-gated retry. Mid-flight tracker mutation by a human (e.g., manually flipping `status=done` while a `runOne` is in progress) is rare, undefined behavior in v1, and not something the orchestrator is responsible for unwinding.
- The single-flight cap means at most one in-flight `runOne` per tick. There's no "stale entry from a prior tick" condition for tick-start reconciliation to address — finished `runOne` calls release their entry via the post-claim `Effect.addFinalizer(state.releaseEffect)` registered at pipeline step 3 (`SWYRD-osqltjnr` §5b).

### Tick serialization

Ticks are awaited, not fire-and-forget. `index.ts` (`SWYRD-ozdpzajz`) wraps `OrchestratorService.runOneTick` in `Effect.repeat(Schedule.spaced(intervalMs))`, which **awaits each tick to completion before the next one fires**. With `maxConcurrentAgents = 1`, this means tick N+1 cannot start until tick N's `runOne` (if any) has completed and released its running-set entry. Reconciliation is therefore unnecessary because the running-set state observed at the top of each tick is the steady-state result of every prior tick — there are no transient mid-flight reads from a different tick.

This serialization is part of the v1 contract. If `index.ts` ever schedules ticks on a fixed interval without awaiting (e.g., to hide long-tail `runOne` durations), tick-start reconciliation becomes load-bearing and this document's premise no longer holds.

## Consequences

### Lost on restart

The orchestrator's claim state lives in process memory (`Ref<RunningSet>`). Process exit drops it; the next process starts with `emptyRunningSet`.

If a `runOne` was mid-flight when the prior process exited:

- The fp issue is left at `status=in-progress`, `symphony_state=active` (or `needs-attention` if the SIGINT/SIGTERM finalizer flushed; see `SWYRD-osqltjnr` §7 SIGINT lock).
- The Daytona sandbox is left running. `autoStopInterval` (default 15 min idle, `WorkflowConfig.sandbox`) reaps the codex process; `autoDeleteInterval` (default `-1` per spec line 400) keeps the sandbox.
- A human re-arms the issue by flipping `symphony_state=idle`, `symphony_ready=true`, `status=todo` in fp. Eligibility picks it up on the next eligible tick.

This is the deliberate v1 posture: **fp state must always reflect reality on shutdown**. SIGINT/SIGTERM are wired (`SWYRD-osqltjnr` §7) to interrupt the in-flight fiber and flush a `markNeedsAttention` write before exit. SIGKILL or hard process death bypasses this; manual operator cleanup is the recovery path.

### No mid-flight tracker reconciliation

Concrete edge cases this leaves on the floor:

- Human flips `status=done` on an in-flight issue. There is no merge: the orchestrator continues to `runOne` completion and issues a blind `markCompleted` (or `markNeedsAttention`) write on its own terminal transition, with no read-then-decide against the intervening human edit. ADR D4 makes the orchestrator the sole `fp` writer, so this is "last write wins" only by construction — there's no contention model to lose. The human can re-edit afterward. v1 accepts this because the cost of detection (re-fetch on every tick) is paid every tick to handle a near-zero-frequency failure mode.
- Human deletes the issue from fp mid-flight. `runOne` continues until it tries `markCompleted/markNeedsAttention` and that fp write fails. Per the failure matrix in `SWYRD-osqltjnr` §7b (row F15), the write is retried once then logged. The running-set entry releases via finalizer regardless.
- Issue's `dependencies` field changes mid-flight (parent now blocks). v1 doesn't re-validate eligibility once `runOne` starts. The orchestrator integrates the worker's branch normally; the dependency change matters only for the *next* tick's eligibility scan.

These are accepted v1 trade-offs. None of them are silent corruption — the worst case is "orchestrator wins the race against a manual fp edit", and the human can re-edit.

### Single-tick semantics

`runOneTick` is therefore (elided for clarity — the `Ref` reads, `WorkflowService` resolution, and error channels are not shown):

```ts
runOneTick = Effect.gen(function* () {
  const { agent } = yield* WorkflowService
  const runningSet = yield* Ref.get(runningSetRef)                  // current set
  const scan = yield* FpService.fetchCandidates(runningSet.entriesById) // running-set passed verbatim
  const verdict = selector.select({                                  // pure
    scan,
    runningSet,
    maxConcurrentAgents: agent.maxConcurrentAgents,
  })
  if (verdict.toDispatch.length > 0) {
    yield* runOne(verdict.toDispatch[0])                             // v1 single-flight
  }
})
```

No reconcile step at the top. With single-flight + serialized ticks (above), the running-set state at the top of tick N+1 is exactly the state at the bottom of tick N — the prior tick's `runOne` either ran to completion (releasing its entry via finalizer) or no entry was added. No transient or stale entries can exist across the tick boundary.

## When this changes

Two follow-ups make tracker-authoritative reconcile load-bearing:

1. **Recovery (`SWYRD-uouprnfv` epic).** A startup-time reconcile that scans fp + Daytona labels to rebuild the running set after orchestrator restart. Per the spec's `## Recovery Rules` section, this needs Daytona label scanning (`fp_issue_id` per ADR D4b) and `outcome-record.json` inspection. v1 explicitly defers this.
2. **Concurrency > 1.** When `maxConcurrentAgents > 1`, multiple `runOne` calls can be in flight concurrently. Cross-fiber coordination still uses the in-memory `Ref<RunningSet>` (single-process per ADR D3), but operational complexity grows. Reconcile semantics may need revisiting at that point.

Until either follows up, identity reconcile is the v1 contract.

## Cross-references

- ADR D2 (`docs/architecture/0001-symphony-deviations.md` `### D2`) — in-memory state authoritative at runtime.
- ADR D3 — single-orchestrator process.
- ADR D5 — human-gated retry (no auto-retry).
- `SWYRD-osqltjnr` §5b — `runOne` pipeline; the post-claim release finalizer that keeps the running set monotonically consistent within a tick.
- `SWYRD-osqltjnr` §7 SIGINT/SIGTERM lock — shutdown reflects reality.
- `SWYRD-jrcqjjmo` — state.ts; the `Ref<RunningSet>` substrate.
- Umbrella vertical-slice spec, `## Orchestrator Flow` — the per-tick pseudocode whose "reconcile in-memory running set against tracker" line this document interprets.
