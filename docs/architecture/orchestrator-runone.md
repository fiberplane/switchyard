# Orchestrator runOne — per-issue lifecycle contract

Status: Active. Scope: **the v1 vertical-slice orchestrator's per-issue runOne pipeline** as
implemented in `apps/symphony-orchestrator/src/orchestrator/service.ts`. This is the focused
doc for the contract that the umbrella spec calls out under `### Orchestrator Flow` and
`### Effect Implementation Shape`. Source files in `orchestrator/` `drift link` here.

The orchestrator service is a **stream integrator** — it composes `FpService`,
`DaytonaAdapter`, `DaytonaSession`, `IntegrationService`, `ArtifactStore`,
`WorkerPromptService`, `SandboxScriptService`, and `AgentRunner` into one driver. It does
not own a sandbox image, does not parse the codex protocol, does not write integration
branches. Each of those concerns lives in a sibling module and is wired via Effect Layers.

Cross-links:

- Umbrella spec: [`### Orchestrator Flow`](../experiments/2026-05-04-symphony-daytona-vertical-slice.md)
  (lines 664–699) and [`### Effect Implementation Shape`](../experiments/2026-05-04-symphony-daytona-vertical-slice.md)
  (lines 701–760) — high-level pipeline + module layout.
- ADR: [`0001-symphony-deviations.md`](./0001-symphony-deviations.md) — D2 (no auto-merge),
  D3 (single-process), D5 (no auto-retry), D7 (self-contained bundles).
- Sibling focused docs:
  [`fp-boundary.md`](./fp-boundary.md),
  [`runner-protocol.md`](./runner-protocol.md),
  [`daytona-streaming-session.md`](./daytona-streaming-session.md),
  [`orchestrator-reconciliation.md`](./orchestrator-reconciliation.md).
- Future considerations under [`SWYRD-uouprnfv`](https://app.fp.dev/issues/SWYRD-uouprnfv):
  streaming-transcript variant (`SWYRD-aaytmsfz`), discriminated codex auth config
  (`SWYRD-jbzbqkon`), branch collision suffix selection (`SWYRD-zituhadq`), forever-running
  sandboxes (`SWYRD-xlgiuegf`), continuation turns (`SWYRD-clnybkgo`).

## Pipeline ordering — the 20 steps

`runOne(issue)` walks 20 ordered steps. The numbering and host/sandbox split mirrors
spec §5b. Reordering is load-bearing: steps 11→12→13 specifically must keep the codex
session closed before `finalize` runs in a separate session.

```
HOST                                                       SANDBOX
─────────────────────────────────────────────────────────  ──────────────────────────────
 1. fp.fetchCandidates → CandidateScan                       (n/a)
 2. selector.select   → toDispatch[0]                        (n/a)
 3. attempt = parseAttempt(properties.symphony_attempt) + 1  (n/a)
 4. integration.prepareSourceHandoff() OR                    (n/a)
    integration.prepareGithubCloneSourceHandoff()
    + Effect.addFinalizer(fs.remove(archivePath)) for archive only
 5. host codex auth read                                     (n/a)
 6. state.claimEffect (running set)                          (n/a)
    + Effect.addFinalizer(state.releaseEffect)
    fp.claimIssue + fp.setAttempt                            (n/a)
 7. daytona.createSandbox({ snapshot, labels, envVars,         (sandbox boots)
      autoStopInterval, autoDeleteInterval })
    + fp.setRunMetadata for githubClone
 8. prompt.renderPrompt(...) + worker env render for githubClone
    + archive mode upload([archive, prompt, codex auth])         (files materialize)
 9. sandboxScripts.setupRepo(...) OR setupClone(...)           (archive init OR pinned remote clone)
    + githubClone upload([prompt, codex auth, worker env])
10. Effect.scoped(daytonaSession.start(handle,                 (codex app-server alive on stdio)
      "cd /workspace/repo && codex app-server"))
11. runner.runTurn({ stream, prompt, cwd, turnTimeoutMs })     (turn runs, codex emits events)
   ── child scope closes here; ProtocolStream.close fires ──
12. transcript.write(runDir, outcome.events)                 (n/a)
13. sandboxScripts.finalizeBundle(handle, ...)                 (archive only)
14. daytona.downloadFiles([work.bundle, outcome.json])         (archive files leave the sandbox)
15. workerOutcome = artifactStore.readOutcome(...)           (n/a)
16. integration.integrateBundle(work.bundle, issueId)        (host git fetch + branch create)
17. artifactStore.writeRecord(outcome-record.json)           (n/a)
18. fp.markCompleted | fp.markNeedsAttention                 (archive terminal writes)
19. (finalizer) state.releaseEffect — running set entry freed
                                                             (sandbox left running; autoStop reaps)
20. (finalizer) fs.remove(prompt/env tempdirs) + fs.remove(archivePath for archive only)
```

Source handoff now has two modes. `archive` preserves the original local handoff: host `HEAD`
is archived, uploaded, and unpacked into a synthetic `symphony-base`; the worker prompt uses
the configured `repoPath` rather than assuming `/workspace/repo`. `githubClone` resolves
`repoUrl` + `baseBranch` with `git ls-remote` while disabling host credential helpers, pins
`baseSha`, uploads only prompt/auth material, and runs sandbox clone setup with temporary
`GIT_ASKPASS` auth before starting Codex in `repoPath`. Host source resolution clears
ambient askpass/token environment (`GITHUB_TOKEN` and `GH_TOKEN`) and host Git config sources
when no decoded GitHub token is configured, so local credential state cannot make a tokenless
workflow appear valid or rewrite the validated GitHub URL. If a scoped GitHub token is used,
`ls-remote` failure stderr is redacted before it can become a `GitCommandError` reason.
Sandbox clone setup applies the same Git config-source sanitization before clone/fetch, then
writes safe-directory into `/tmp/.symphony/gitconfig`; the Codex app-server command exports
that path as `GIT_CONFIG_GLOBAL` and disables system/env Git config sources so later
worker-side Git operations inherit the safe-directory setting without inheriting image-global
credential config. Clone setup also writes a persistent `/tmp/.symphony/git-askpass` script
that reads `GITHUB_TOKEN` from the worker process environment; the token is supplied through a
temporary `/tmp/.symphony/worker-env` bridge uploaded outside the repo and removed as the
app-server session starts. Clone setup fetches the branch ref and the exact pinned SHA before
checkout, so a branch move between host resolution and sandbox setup does not silently change
the worker base. Clone setup writes `/tmp/.symphony/source.json` with the sanitized clone
metadata (`repoUrl`, `baseBranch`, `baseSha`, `repoPath`, `branchName`) so the worker-owned PR
workflow can create and push the deterministic branch without asking the orchestrator for more
state.

For `githubClone`/PR runs, the orchestrator writes `symphony_branch`,
`symphony_base_sha`, `symphony_run_id`, and `symphony_sandbox_id` at handoff, injects fp REST
and GitHub credentials into the app-server process without rendering secrets into commands or
prompts, and then stops after the worker turn completes. Until the fp no-clone property-write
spike proves worker-side PR metadata writes, a completed worker turn records a local
`needs-attention` gate reason rather than a false integrated result. It does not
finalize/download bundles, decode `outcome.json`, integrate a host branch, or write
`symphony_artifact`. Non-completed `githubClone` turns still skip bundle salvage because there is
no archive/bundle return channel for the remote PR strategy; before parking the issue
needs-attention, the orchestrator checks whether the worker already wrote terminal state and
skips the fp write if it did.

### Adjacencies that must not change

- **6 before fp claim writes.** State-claim's finalizer must register before the fp claim transition so
  the running-set slot frees on every exit path (success / failure / interrupt) regardless
  of whether the fp write succeeded.
- **4+5 before 6.** Pre-claim source preparation and host codex auth checks can fail and route to "log + skip" without
  ever entering the running set or writing fp. Sequential by default; parallelizing via
  `Effect.all` saves ~tens of ms but adds error-merging complexity not worth the v1 cost.
- **7 before prompt render.** `githubClone` prompts include the actual Daytona sandbox id, so prompt
  rendering happens after sandbox creation and failures route through post-claim setup handling.
- **11 inside `Effect.scoped`, 12 outside it.** The codex session's Scope must close
  (releasing the SDK's WebSocket and the EXIT-trap watcher) before step 13's
  `executeCommand` for `finalizeBundle` runs. Sharing a scope would let `git bundle create`
  race against the still-open codex session inside the same shell.
- **12 before 13.** `transcript.write` is buffered post-completion (G1 lock): writing the
  transcript before bundling means a finalize failure still leaves the conversation log
  on disk for forensics. `githubClone` skips step 13 entirely and must not fall back to
  archive/bundle salvage.
- **15 before 16.** Worker-outcome decode failure is part of the integration-routing
  decision (F10: forensic branch with plain name). Decoding after integration would force
  a second integration pass.
- **18 last fp write for archive.** All other fp writes (claim, setAttempt, setRunMetadata,
  addComment) are
  intermediate; `markCompleted`/`markNeedsAttention` is the terminal write that consumers
  poll for state. In `githubClone`/PR mode, the worker owns later PR and terminal fp writes.

## Failure matrix

For every failure mode in the pipeline: was the issue claimed at the time of failure, what
fp transition fires, what `symphony_last_error` string is set, and what is left running.

Three rules underlie the table:

1. **Pre-claim failures** (F1, F2b) never write fp. They log + skip + try the next
   candidate. State.ts isn't entered yet.
2. **Post-claim failures** always release the running-set entry via the
   `addFinalizer(state.releaseEffect)` registered at step 3. Slot frees regardless of
   outcome.
3. **Sandbox is never proactively deleted.** Even on F3 (sandbox created but a later step
   failed), the sandbox is forensic evidence until `autoStopInterval` reaps the codex
   process; `autoDeleteInterval=-1` keeps it for manual cleanup. Service.ts MUST NOT call
   `daytona.deleteSandbox`.

| #   | Step                                                           | Error type (typed)                         | Issue claimed yet?             | fp transition                                                                                 | `symphony_last_error`                                                    |
| --- | -------------------------------------------------------------- | ------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| F1  | source handoff preparation (4)                                  | `GitCommandError`                          | **No** (fails before claim)    | None — log + skip                                                                             | n/a                                                                      |
| F2b | host `auth.json` missing (5)                                    | `MissingCodexAuthError`                    | **No**                         | None — log + skip; orchestrator-level operator alert                                          | n/a                                                                      |
| F3  | `daytona.createSandbox` (7)                                    | `DaytonaSandboxCreateError`                | **Yes** (claim before sandbox) | `markNeedsAttention`                                                                          | `"sandbox create failed: <reason head>"`                                 |
| F4  | `renderPrompt`, worker env render, or `daytona.uploadFiles` (8) | `WorkerPromptError` / FS / `DaytonaSandbox*` | Yes                          | `markNeedsAttention`                                                                          | `"worker prompt render failed..."`, `"worker env render failed..."`, or `"sandbox upload failed..."` |
| F5  | `sandboxScripts.setupRepo` / `setupClone` (9)                  | `SandboxScriptError \| DaytonaSandbox*`    | Yes                            | `markNeedsAttention`                                                                          | `"sandbox setup failed: <reason head>"`                                  |
| F6  | `daytonaSession.start` (10)                                    | `DaytonaSessionStartError`                 | Yes                            | `markNeedsAttention`                                                                          | `"codex app-server start failed: <reason head>"`                         |
| F7  | `runner.runTurn` returns non-`completed` `TurnOutcome` (11)    | none — outcome union                       | Yes                            | `markNeedsAttention`; archive mode does **best-effort** finalize+download for forensics; `githubClone` skips bundle salvage and skips fp write if worker already wrote terminal state | `"protocol stream <kind>: <reason head>"`                                |
| F7b | `runner.runTurn` errors (timeout, framing, send)               | `RunnerError`                              | Yes                            | same as F7, including the conditional `githubClone` terminal-state skip                       | `"protocol stream error: <reason head>"`                                 |
| F8  | `sandboxScripts.finalizeBundle` (13)                           | `SandboxScriptError`                       | Yes                            | `markNeedsAttention`                                                                          | `"bundle finalize failed: <reason head>"`                                |
| F9  | `daytona.downloadFiles` (14)                                   | `DaytonaSandbox*`                          | Yes                            | `markNeedsAttention`                                                                          | `"artifact download failed: <reason head>"`                              |
| F10 | `artifactStore.readOutcome` (15) — file missing or decode fail | `ArtifactPathError \| ArtifactDecodeError` | Yes                            | `markNeedsAttention`; integrate bundle anyway (forensic branch with plain name)               | `"malformed worker outcome"`                                             |
| F11 | Empty bundle (`commitsBeyondBase=0`)                           | none — value check                         | Yes                            | `markNeedsAttention`; skip integrate                                                          | `"worker produced no commits"` (or `"completed status with no commits"`) |
| F12 | Worker `outcome.status` ≠ `"completed"` + bundle has commits   | none — value check                         | Yes                            | `markNeedsAttention`; **integrate branch (plain `symphony/<id>` name, no `-blocked` suffix)** | `"<status>: <summary head>"`                                             |
| F13 | `integration.integrateBundle` (16)                             | `BundleFetchError \| GitCommandError`      | Yes                            | `markNeedsAttention`; bundle preserved at `runDir/work.bundle`                                | `"bundle integration failed: <reason head>"`                             |
| F14 | `artifactStore.writeRecord` (17)                               | `ArtifactPathError \| ArtifactDecodeError` | Yes                            | `markNeedsAttention`                                                                          | `"orchestrator record write failed: <reason head>"`                      |
| F15 | terminal fp write (18)                                         | `WriteError` → `FpWriteFailedError`        | Yes                            | retry once, then log + leave issue in `in-progress` (no recovery in v1)                       | n/a (best-effort)                                                        |
| F16 | SIGINT/SIGTERM (any time after claim)                          | `Interrupt`                                | Yes                            | `markNeedsAttention` (locked)                                                                 | `"orchestrator interrupted by signal"`                                   |
## Scope tree (Option 1)

`runOne` opens **one outer scope** that owns the running-set release finalizer plus the two
host-tempdir cleanup finalizers (prompt dir + source archive dir). Inside that outer scope,
step 11 opens a **child scope** via `Effect.scoped(runTurn)` so the codex session's
WebSocket + EXIT-trap watcher close before step 13's separate-session finalize runs.

Visualised:

```
runOne outer Scope
├── finalizer: releaseEffect(issueId)        ← runs LAST on exit (LIFO)
├── finalizer: fs.remove(rendered.hostPath)
├── finalizer: fs.remove(handoff.archivePath)  ← archive mode only
├── claimEffect / fp.claimIssue / fp.setAttempt / fp.addComment
├── daytona.createSandbox / uploadFiles / setupRepo OR setupClone
├── child Scope (Effect.scoped)
│   ├── daytonaSession.start
│   │   └── (acquireRelease registers session.close as scope finalizer)
│   └── runner.runTurn
│       └── (returns TurnOutcome)
│   ── child scope closes here; session.close + EXIT-trap watcher tear down ──
├── transcript.write(runDir, events)
├── sandboxScripts.finalizeBundle
├── daytona.downloadFiles
├── artifactStore.readOutcome / integrateBundle / writeRecord
└── fp.markCompleted | fp.markNeedsAttention
```

Per-phase isolation (Option 2 — every phase in its own child scope) is the v2 refactor
target if per-phase retry/timeout policies grow up.

## Three-comment cadence

Every dispatched issue produces three fp comments:

1. **Dispatched.** After step 7 succeeds: `Dispatched to sandbox \`<sandbox-id>\``.
2. **Integrating.** After step 11 returns a `completed` outcome: `Worker turn completed; integrating`.
3. **Final.** Inline on step 18 via `markCompleted(id, summary)` or
   `markNeedsAttention(id, summary)`. The summary is **pass-through verbatim** — no
   truncation, no header-prepend, no link-to-transcript wrapping. The `summary head`
   truncation rule applies only to the `symphony_last_error` property (200-char first-line
   cap, `…` suffix on truncation), not to the comment body.

On partial failure between Dispatched and Turn completed (any of F3–F8), only the failure
comment + property write fires — no salvaged "integrating" comment.

## v1 demo codex auth (file-copy)

The orchestrator does NOT inject a scoped `OPENAI_API_KEY` into the sandbox env. Instead:

- Read host `~/.codex/auth.json` (or `SWITCHYARD_CODEX_AUTH` / `CODEX_AUTH_JSON` override).
  Pre-claim check (F2b): missing → `MissingCodexAuthError` → log + skip.
- Upload to sandbox at `/workspace/codex-home/auth.json` as part of the step-8 batched
  `uploadFiles` call.
- Set `envVars: { CODEX_HOME: "/workspace/codex-home" }` on `daytona.createSandbox`. Do
  NOT set `OPENAI_API_KEY` or `SANDBOX_OPENAI_API_KEY` — either masks the copied ChatGPT
  subscription auth.

Productionizing codex auth (discriminated `apiKey` vs `fileCopy` config, scoped-key
injection) is deferred to `SWYRD-jbzbqkon` under epic `SWYRD-uouprnfv`.

## Configuration injection

`OrchestratorServiceLive(config)` takes an `OrchestratorServiceConfig` value at Layer
construction time rather than depending on `WorkflowService` at runtime. This deviates from
the umbrella spec's `### Effect Implementation Shape` requirements list, which originally
showed `WorkflowService` in the requirements channel for `OrchestratorService`.

Reason: the orchestrator only needs a projection out of `WorkflowConfig`
(`agent.maxConcurrentAgents`, `codex.turnTimeoutMs`, `sandbox.snapshot`,
`sandbox.autoStopInterval`, `sandbox.autoDeleteInterval`, `sandbox.repoPath`, and the source
strategy) plus host env values such as Codex auth path and GitHub token. Loading the workflow
file from inside `runOne` would couple the orchestrator to file IO it doesn't otherwise need;
index.ts (the entrypoint) loads the config once at boot and passes the projection to
`OrchestratorServiceLive`. The pattern matches `ArtifactStoreLive(basePath)`.

## Buffered transcript (known dark corner)

The §7 G1 lock pinned the transcript shape to **buffered post-completion**: service.ts
writes from `TurnOutcome.events: ReadonlyArray<RunnerNotification>` after `runner.runTurn`
returns. The streaming variant (live persistence as events arrive) is filed under
`SWYRD-aaytmsfz` (epic U).

**Implication.** On protocol-stream failure mid-turn (F7b), the runner returns no events
to write and the `transcript.jsonl` file is empty. This degrades debugging on the
crash-in-flight path; rationale for accepting the trade-off is in the §7 decision log on
`SWYRD-osqltjnr`.

## What runOneTick adds

Per-tick driver:

1. Read the running set; bail with empty `TickResult` if `availableSlots <= 0`.
2. Call `fp.fetchCandidates(runningIds)` and run the selector.
3. Dispatch at most one issue per tick (single-flight v1 — `maxConcurrentAgents=1`).
4. Dispatch through the same tracked `runOne` wrapper as direct callers, so `stop` can interrupt a
   run that began from the poll loop.
5. Return `TickResult { dispatched, skipped }` synchronously.

Index.ts wraps `runOneTick` in `Effect.repeat(Schedule.spaced(intervalMs))` so the loop
stays testable without a real interval. Concurrency >1 is deferred (see ADR D3).

## What stop owns

`OrchestratorService.stop` interrupts the in-flight `runOne` fiber (if any) and lets the
outer scope's finalizers fire. The interrupt path is per spec §7 SIGINT/SIGTERM lock:
fp write `symphony_last_error="orchestrator interrupted by signal"` and park
`needs-attention`. Index.ts wires `process.on("SIGINT"/"SIGTERM", ...)` to call
the shutdown branch, which runs `orch.stop` and exits the poll loop cleanly.

## Where this doc lives

`docs/architecture/orchestrator-runone.md` is the per-issue contract. Source files in
`apps/symphony-orchestrator/src/orchestrator/` `drift link` here. Reconciliation /
recovery semantics live in [`orchestrator-reconciliation.md`](./orchestrator-reconciliation.md).
The umbrella spec section that originated this doc is
[`### Orchestrator Flow`](../experiments/2026-05-04-symphony-daytona-vertical-slice.md).
