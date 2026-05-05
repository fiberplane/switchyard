---
name: Vertical Slice Happy Path
requires:
  [
    setup-daytona-test-stack,
    setup-host-repo,
    bootstrap-codex-auth,
    create-fp-issue,
    setup-workflow-config,
  ]
---

# Vertical Slice Happy Path

## Goal

Verify a code-change `fp` issue dispatches → sandbox boots → `codex app-server` produces commits
→ bundle integrates as a `symphony/<id>` branch on the host repo → fp transitions to `done` with
`symphony_state=end` and `symphony_artifact="symphony/<id>"`.

Also verifies the structured-log contract (terminal output is JSON lines with the canonical key
set: `issue_id`, `issue_display_id`, `attempt`, `sandbox_id`, plus `level`, `timestamp`,
`message`).

## Success fact set

A passing run produces all six of these facts. The Steps below derive each one.

1. **Structured-log contract.** Terminal output is JSON lines (one per log event), each
   containing `level`, `timestamp`, `message`, and — for log events emitted inside an issue's
   processing — the four canonical annotation keys `issue_id`, `issue_display_id`, `attempt`,
   `sandbox_id` (per spec line 769-770 and the observability focused doc that ships with
   `SWYRD-ozdpzajz`).
2. **fp transitions.** `status: todo → in-progress → done`, with
   `symphony_state: idle → active → end` and a final `symphony_artifact = "symphony/<issue-id>"`.
3. **fp comment cadence.** Three comments fire in order, in line with the locked behavior
   (osqltjnr §7 — exact templates):
   - `` Dispatched to sandbox `<sandbox-id>` `` (after Claim — backticks around the id)
   - `Worker turn completed; integrating` (after `turn/completed`)
   - The worker's `outcome.summary` text passed through verbatim (after Integration ok)
4. **Host repo branch.** A new branch `symphony/<issue-id>` exists, branched from the host's
   pre-dispatch SHA (`baseRev`), with the worker's commits on top. The marker line from
   `fixtures/sample-code-task.md` appears in the diff against the base.
5. **Run record on disk.** `<host-repo>/.symphony/runs/<issue-id>/1/` contains
   `transcript.jsonl`, `outcome.json`, `outcome-record.json`, `work.bundle` (per spec lines
   624-632 and `apps/symphony-orchestrator/src/artifact/store.ts`).
6. **Sandbox left alive.** `autoDeleteInterval: -1` keeps the sandbox after the run for
   forensic SSH access (per workflow fixture). Operator can prune via `helpers/cleanup.md`.

## Prerequisites

- All scenario `requires:` helpers run successfully:
  - Daytona test stack up; `symphony-test-codex` snapshot active.
  - Isolated host repo at `/tmp/swyrd-qa-host-<timestamp>/` with an initial commit and a
    `README.md` to append to.
  - Host has a working `~/.codex/auth.json` (ChatGPT auth; no `OPENAI_API_KEY` env vars).
  - One fp issue in `todo` with `symphony_ready=true` and the `sample-code-task.md` body.
  - `WORKFLOW.md` materialized at the host repo root with concrete Daytona values.
- All hard preconditions for the orchestrator have shipped: `SWYRD-osqltjnr` (service),
  `SWYRD-jrcqjjmo` (state — done), `SWYRD-shdtddfg` (selector), `SWYRD-ozdpzajz` (index.ts).
  This scenario is meant to be run against a fully-implemented v1; running it earlier will
  surface implementation gaps as scenario failures.

## Steps

Each step has a **Command pattern** (the shape, not literal — substitute concrete values), an
**Expected** outcome, and a **Verify** check. Run them in order.

### 1. Capture pre-dispatch host state

**Command pattern:**

```
cd <host-repo>
git rev-parse HEAD                         # capture baseRev for later verification
git branch                                 # confirm no symphony/* branches exist yet
ls -la .symphony 2>/dev/null || echo "no .symphony yet"
```

**Expected:**

- `baseRev` is a concrete SHA (the orchestrator will record it under
  `OrchestratorRecord.baseRev` per spec line 615).
- No `symphony/*` branches exist.
- `.symphony/` directory does not yet exist.

**Verify:** Save `baseRev` somewhere — the result file's `## Run inputs` section is a good
place. You'll cross-reference it against `outcome-record.json` in step 9.

### 2. Capture the fp issue's pre-dispatch state

**Command pattern:**

```
fp issue get <issue-id>
```

**Expected:**

- `status: todo`
- `symphony_ready: true`
- `symphony_state: idle` (or unset — defaults to `idle` via
  `decodeSymphonyProperties` per `apps/symphony-orchestrator/src/fp/symphony-properties.ts`)
- No `symphony_artifact`, `symphony_attempt`, or `symphony_last_error` set
- No comments yet (or only operator-authored comments, no orchestrator-authored ones)

**Verify:** Capture this snapshot; you'll diff against the post-run state in step 11.

### 3. Boot the orchestrator

From the **host repo** working directory (so `.symphony/runs/` lives under it; per ozdpzajz
artifact-base-path decision and `apps/symphony-orchestrator/src/artifact/store.ts:221`):

**Command pattern:**

```
cd <host-repo>
bun run --filter @switchyard/symphony-orchestrator start -- --workflow ./WORKFLOW.md
```

The `start` script comes from `apps/symphony-orchestrator/package.json` (added in
`SWYRD-ozdpzajz` cycle 6). The `--workflow ./WORKFLOW.md` flag is the default; pass it
explicitly for clarity.

For richer trace output during the run (very helpful for QA verification):

```
EFFECT_TRACE=1 LOG_LEVEL=debug bun run --filter @switchyard/symphony-orchestrator start -- --workflow ./WORKFLOW.md
```

**Expected:**

- The process starts. The first log line confirms config load — something like
  `{"level":"info","message":"workflow config loaded","path":"./WORKFLOW.md", ...}`.
- The next tick (~5 seconds later, per `polling.intervalMs: 5000`) emits a candidate-fetch log
  line (the orchestrator polls `fp` for ready issues).
- The orchestrator picks up the QA issue and begins the dispatch flow.

**Verify:**

- All terminal output is JSON-shaped (one log event per line). If you see
  multi-line tracebacks or `console.log`-shaped plaintext, the structured logger contract is
  broken — file a backport on `SWYRD-ozdpzajz`.
- No `WorkflowDecodeError` or `WorkflowFileMissing` on boot. Either of those means
  `helpers/setup-workflow-config.md` substitutions weren't applied.
- The process does NOT exit; it runs the poll loop until interrupted.

### 4. Verify the Claim transition

Within the first poll tick after boot (~5-15 seconds), watch the log stream and `fp issue get
<issue-id>` for the Claim transition:

**Command pattern:**

```
# In a second terminal:
watch -n 1 fp issue get <issue-id>
```

**Expected (per spec state-flow row "Claim", lines 691-693):**

- `fp` write: `status=in-progress`, `symphony_state=active`, `symphony_attempt="1"`.
- A new fp comment with the exact locked template (osqltjnr §7):
  `` Dispatched to sandbox `<sandbox-id>` `` (note backticks around the id).
- Log lines annotated with `issue_id`, `issue_display_id`, `attempt`, and `sandbox_id` once
  the sandbox is created. The `attempt` value is `"1"` if the logger sources from the fp
  property (string-encoded — see `apps/symphony-orchestrator/src/fp/symphony-properties.ts:12`)
  or `1` if it sources from the orchestrator's claim counter (number — see
  `apps/symphony-orchestrator/src/artifact/models.ts:25`). Confirm against the logger's
  annotation site once `observability/logger.ts` lands.

**Verify:**

- The log contains a structured event whose annotation set matches the four-key contract
  (per spec line 769-770).
- The comment text matches the locked Dispatched template byte-for-byte (osqltjnr §7),
  including the backticks around the sandbox id.

### 5. Verify sandbox creation

The orchestrator's runOne pipeline (osqltjnr §3) creates a Daytona sandbox labelled with the
`fp_issue_id`. From the Daytona dashboard or SDK:

**Command pattern:**

```
# Via the dashboard at http://localhost:33000, find the running sandbox
# Or via curl with the admin key:
curl -H "Authorization: Bearer $DAYTONA_API_KEY" "$DAYTONA_API_URL/api/sandbox" | jq '.[] | select(.labels.fp_issue_id == "<issue-id>")'
```

**Expected:**

- One sandbox exists, labelled `fp_issue_id=<issue-id>`.
- Snapshot is `symphony-test-codex`.
- Status is running / executing.
- The sandbox-id matches what was logged in step 4 and posted in the Dispatched comment.

**Verify:** Cross-reference the sandbox-id between three places (log annotation, fp comment,
Daytona API). Mismatch = the labelling-vs-logging contract drifted.

### 6. Watch the protocol stream

The transcript is written to `<host-repo>/.symphony/runs/<issue-id>/1/transcript.jsonl` as
events arrive (per spec line 678). In a third terminal:

**Command pattern:**

```
tail -f <host-repo>/.symphony/runs/<issue-id>/1/transcript.jsonl | jq .
```

**Expected (per spec lines 200-222 — `codex-cli 0.128.0` protocol shape):**

- An `initialize` request/response pair.
- A `thread/start` request/response with `approvalPolicy: "never"` and
  `sandbox: "danger-full-access"`.
- A `turn/start` request/response with the rendered prompt as `input[0].text`.
- A stream of `item/agentMessage/delta` events while the worker thinks.
- One or more `item/started` / `item/completed` pairs as the worker takes actions
  (file edits, shell commands).
- One or more `turn/diff/updated` events as the worker writes code.
- Eventually a `turn/completed` notification (this is the terminal event for the turn).

**Verify:**

- No `item/tool/requestUserInput` events fire (per spec line 220-222 — these are treated as a
  hard turn failure under v1; the happy-path task should not provoke one).
- No `applyPatchApproval` / `execCommandApproval` requests should normally fire under
  `approvalPolicy: "never"`, but if any do, the orchestrator's auto-handler must respond
  `{decision: "approved"}` (per spec line 218 / sandbox-policy lock). Verify by inspecting the
  response payload.
- The worker eventually emits `turn/completed`. If the turn hangs past `turnTimeoutMs`
  (1 hour, per workflow fixture / `osqltjnr` §7), that's a per-turn-deadline test, not a
  happy-path success.

### 7. Verify the "Worker turn completed" comment

After `turn/completed` arrives, the orchestrator posts the second comment per the locked
three-comment cadence (osqltjnr §7):

**Command pattern:**

```
fp issue get <issue-id>
```

**Expected (per spec state-flow row "Turn completed", lines 691-695):**

- A new fp comment: `Worker turn completed; integrating`.
- No `fp` property changes yet (still `status=in-progress`, `symphony_state=active`).
- The orchestrator now begins downloading the bundle and `outcome.json`.

**Verify:** The exact comment text matches the locked template. If it differs, file a backport
on `osqltjnr`.

### 8. Verify integration into the host repo

Once the bundle download + decode succeed, the orchestrator runs the host-side integration
step (per spec lines 634-660). On the host:

**Command pattern:**

```
cd <host-repo>
git branch -a | grep symphony
git log --oneline symphony/<issue-id>
git diff <baseRev>..symphony/<issue-id> -- README.md
```

**Expected (per spec state-flow row "Integration ok", lines 691-696):**

- A new branch `symphony/<issue-id>` exists, branched from `<baseRev>` (captured in step 1).
- One or two commits on top of `<baseRev>` modifying `README.md`.
- The diff against `<baseRev>` shows the marker line from
  `packages/qa/fixtures/sample-code-task.md`:
  ```
  +<!-- vertical-slice-marker: SWYRD QA happy-path run -->
  ```
- Each commit message is preserved (verifying the bundle's full-history claim per spec line
  655-656).

**Verify:**

- The branch is **on top of `<baseRev>` exactly** — `git merge-base
symphony/<issue-id> <baseRev>` returns `<baseRev>`. If it doesn't, the bundle was rooted at
  the wrong base.
- No `symphony/<issue-id>-attempt2` collision branch was created (we're on attempt 1; collision
  branches are only created on re-arm — see scenario 04).

### 9. Verify the Integration ok fp transition

**Command pattern:**

```
fp issue get <issue-id>
fp context <issue-id>           # full context including comments in chronological order
```

**Expected (per spec state-flow row "Integration ok"):**

- `status: done`
- `symphony_state: end`
- `symphony_artifact: "symphony/<issue-id>"`
- `symphony_attempt: "1"` (still 1; no auto-retry per ADR D5)
- `symphony_last_error` is unset / empty
- A new fp comment: the worker's `outcome.summary` text passed through verbatim (locked
  pass-through behavior, osqltjnr §7).

**Verify:**

- The summary text matches the worker's `outcome.json` (next step) byte-for-byte. If it
  differs, the pass-through contract is broken.

### 10. Verify the run record on disk

**Command pattern:**

```
ls -la <host-repo>/.symphony/runs/<issue-id>/1/
cat <host-repo>/.symphony/runs/<issue-id>/1/outcome.json | jq .
cat <host-repo>/.symphony/runs/<issue-id>/1/outcome-record.json | jq .
git bundle list-heads <host-repo>/.symphony/runs/<issue-id>/1/work.bundle
```

**Expected (per spec lines 624-632 and `apps/symphony-orchestrator/src/artifact/`):**

- `transcript.jsonl` — the protocol stream, one JSON event per line.
- `outcome.json` — the worker's envelope. Decodes against `WorkerOutcomeSchema` at
  `apps/symphony-orchestrator/src/artifact/models.ts`:
  ```json
  {
    "status": "completed",
    "summary": "<markdown narrative>"
  }
  ```
- `outcome-record.json` — the orchestrator's record. Decodes against
  `OrchestratorRecordSchema` (`apps/symphony-orchestrator/src/artifact/models.ts:17-26`).
  `workerStatus` uses `Schema.OptionFromNullOr(WorkerStatusSchema)`, which encodes
  `Some(x)` as the bare value `x` and `None` as `null` — the on-disk JSON shape is
  therefore:
  ```json
  {
    "status": "integrated",
    "branch": "symphony/<issue-id>",
    "baseRev": "<baseRev from step 1>",
    "workerStatus": "completed",
    "startedAt": "<ISO 8601>",
    "endedAt": "<ISO 8601>",
    "attempt": 1
  }
  ```
  (decoded in-memory: `Option.some("completed")`).
- `work.bundle` — verifiable with `git bundle verify` and listable with `git bundle list-heads`
  (should show one head: `HEAD`).

**Verify:**

- `outcome-record.json#baseRev` equals the `baseRev` captured in step 1.
- `outcome-record.json#status` is `"integrated"` (not `"needs-attention"`).
- `outcome-record.json#workerStatus` is the string `"completed"` on disk (encoded as bare
  string by `OptionFromNullOr`; in-memory it decodes to `Option.some("completed")`).
- `outcome-record.json#attempt` is `1` (number — `Schema.Number` per
  `artifact/models.ts:25`).
- `outcome.json` decodes cleanly against `WorkerOutcomeSchema`.
- The summary in `outcome.json` matches the third fp comment exactly.

### 11. Verify the structured-log contract end-to-end

Re-read the captured log stream (or scrollback). The contract from spec line 769-770:

> Structured logs always include `issue_id`, `issue_display_id`, `attempt`, and `sandbox_id`
> when available.

**Command pattern:**

```
# If you redirected logs to a file:
cat <log-file> | jq -c 'select(.issue_display_id != null) | {level, message, issue_display_id, attempt, sandbox_id}' | head -40
```

**Expected:**

- Every issue-scoped log event (Claim onward) carries all four annotation keys.
- `issue_display_id` is the `SWYRD-xyz` form, not the long internal id.
- `attempt` is `"1"` or `1` (see step 4 — type depends on the logger annotation site;
  consistent within a run).
- `sandbox_id` matches the Daytona sandbox UUID from step 5.
- `level` is one of `info`, `warn`, `error`, `debug` (the standard Effect log levels).
- `timestamp` is ISO 8601 / RFC 3339.

**Verify:** No log event emitted _inside_ an issue's processing scope is missing one of the
four keys. Pre-claim events (config load, polling tick before any candidate is selected) may
omit `issue_display_id` etc. — that's expected.

### 12. Capture results

Before cleanup, capture into `packages/qa/results/YYYY-MM-DD-HHMM-vertical-slice-happy-path.md`:

- The fp issue display ID and final state.
- The host `<baseRev>` and the resulting `symphony/<issue-id>` SHA.
- The Daytona sandbox-id.
- The codex-cli version reported from inside the sandbox (`codex --version`).
- A representative slice of the structured-log output (5-10 events covering Claim, mid-turn,
  turn-completed, integration, done).
- The `outcome.json` summary text verbatim.
- Any deviations from Expected — these are the most valuable backport candidates.

If this is a canonical run worth committing as proof-of-life, `git add -f` the result file.

## Cleanup

Per `helpers/cleanup.md`:

- SIGINT the orchestrator (Ctrl-C). Per the locked SIGINT behavior, it will interrupt cleanly
  and exit; no needs-attention is set because the issue already reached `done` before the
  signal.
- Prune the QA-run sandbox via the Daytona dashboard (autoDeleteInterval=-1 leaves it).
- Remove the host repo temp directory.
- Decide what to do with the fp issue (archive vs. leave for reference).

## Edge cases worth noting (non-blocking; capture as observations in result file)

- **First-run snapshot pull.** If `symphony-test-codex` was just rebuilt, the first sandbox
  creation may take noticeably longer than subsequent ones — Daytona pulls the image. Don't
  treat this as a hang.
- **Host clock skew.** `outcome-record.json#startedAt` and `#endedAt` come from the
  orchestrator's clock. `transcript.jsonl` event timestamps come from the codex protocol
  layer. Small skews (sub-second) are normal.
- **Worker chatty / quiet.** The worker may produce one commit or several; both are valid for
  the happy path. The fixture task suggests one or two; verify whichever the worker actually
  produced.
- **Bundle size.** A README append should produce a `work.bundle` of ~1-2 KB. Anything in the
  multi-megabyte range suggests the bundle isn't deltaed against `symphony-base` correctly
  (per ADR D7 — bundle is self-contained, but a tiny self-contained bundle is still tiny if
  the base repo is small).

## Drift links to apply

After this scenario stabilizes, run from the repo root:

```
drift link packages/qa/scenarios/01-vertical-slice-happy-path.md apps/symphony-orchestrator/src/fp/symphony-properties.ts
drift link packages/qa/scenarios/01-vertical-slice-happy-path.md apps/symphony-orchestrator/src/workflow/models.ts
drift link packages/qa/scenarios/01-vertical-slice-happy-path.md apps/symphony-orchestrator/src/artifact/models.ts
drift link packages/qa/scenarios/01-vertical-slice-happy-path.md apps/symphony-orchestrator/src/index.ts
drift link packages/qa/scenarios/01-vertical-slice-happy-path.md apps/symphony-orchestrator/src/observability/logger.ts
```

These cover the surfaces this scenario embeds in the success path: property schema, workflow
schema, artifact record shape, entry-point invocation, structured-log contract.

**Anchors deferred:**

- `apps/symphony-orchestrator/src/orchestrator/service.ts` — reserve for failure-path
  scenarios (02, 03, 05) that embed the locked `symphony_last_error` sentinels. Scenario 01
  (success path) doesn't cite a sentinel string, so anchoring would just create churn on
  every service.ts edit.
- `docs/architecture/observability.md` — apply only after `SWYRD-ozdpzajz` splits that doc
  out as part of its reflection step. Until then, the link target doesn't exist.
