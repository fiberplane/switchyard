# Cleanup

## Goal

Tear down the artifacts created by a QA scenario run so the next run starts from a clean slate
(or so you stop paying for idle Daytona sandboxes).

## What needs to be cleaned

In rough order:

1. **Orchestrator process.** Stop with SIGINT (Ctrl-C). Per the locked SIGINT/SIGTERM behavior
   (osqltjnr §7), this interrupts the in-flight `runOne` and parks any currently-claimed issue
   at `symphony_state=needs-attention` with
   `symphony_last_error="orchestrator interrupted by signal"`. If the issue has already
   reached `done` (or the orchestrator is idling between candidates), no parking write fires —
   there's nothing in flight to interrupt and the process exits cleanly.
2. **Daytona sandboxes.** v1 sets `autoDeleteInterval: -1` so sandboxes accumulate forever. List
   them and prune what you don't need:
   - List via the Daytona dashboard (`http://localhost:33000`) or the SDK.
   - Sandboxes are labelled with `fp_issue_id` (per ADR D4b — that's how recovery would
     identify them); use the label to find QA-run sandboxes specifically.
   - Note: `SWYRD-xlgiuegf` tracks the v2 retention concern; v1 leaves cleanup manual.
3. **Daytona test stack.** Bring it down via the orchestrator workspace's `test:daytona:down`
   script when you're done with the whole QA pass. Volumes are reclaimed.
4. **Host repo.** The temp directory created in `helpers/setup-host-repo.md` contains:
   - `.git/` and any `symphony/<issue-id>` integration branches (audit trail — preserve if the
     run is worth documenting).
   - `.symphony/runs/<issue-id>/<attempt>/` with `transcript.jsonl`, `outcome.json`,
     `outcome-record.json`, `work.bundle` per the run-record layout (spec lines 624-632).
   - `WORKFLOW.md` materialized from the fixture.
     Remove the entire temp directory once the result file is captured.
5. **fp issues.** Created issues persist in the project. Either leave them (the `symphony_*`
   properties tell the story of the run) or archive via `fp issue update --status archived
<id>` once the result file is captured. Don't bulk-delete — real tickets may share the
   project.
6. **Result file.** If the run is worth preserving, copy walkthrough captures into
   `packages/qa/results/YYYY-MM-DD-HHMM-<scenario-slug>.md` and `git add -f` to commit. Result
   files are gitignored by default.

## What to NOT clean

- The host's `~/.codex/auth.json`. It's untouched by the orchestrator (only copied into
  sandboxes). Leave it.
- The `symphony-test-codex` snapshot. It's slow to rebuild; keep it cached on the test stack.
- The test-stack admin API key file (typically `/tmp/daytona-api-key-pjy` or similar). Reusable
  across runs.
- `packages/qa/fixtures/`. Templates, not per-run artifacts.

## Forensic preservation

If a scenario _failed_, prefer keeping the artifacts before cleanup:

- The sandbox stays alive (autoDeleteInterval=-1) — SSH in for forensics. The Daytona
  dashboard's terminal works; `daytona ssh <sandbox-id>` works if you have the CLI.
- `.symphony/runs/<id>/<attempt>/transcript.jsonl` is the protocol replay; grep for
  `turn/completed`, error responses, etc.
- `.symphony/runs/<id>/<attempt>/outcome.json` is what the worker wrote (or absent if the
  worker died before writing it).
- `.symphony/runs/<id>/<attempt>/outcome-record.json` is what the orchestrator wrote.
- `.symphony/runs/<id>/<attempt>/work.bundle` can be inspected with `git bundle list-heads
<bundle>` and `git bundle verify <bundle>`.

Capture the relevant files into the result file's `## Artifacts` section before deleting
anything.

## Idempotency

Cleanup should be safe to re-run. If a step is already done (sandbox already deleted, host repo
already removed), the helper should just no-op rather than error.
