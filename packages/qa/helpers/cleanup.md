# Remote Daytona Cleanup

## Goal

Clean up resources from a remote Daytona E2E run without touching implementation tickets,
unrelated branches, unrelated PRs, or unrelated sandboxes.

## Normal Path

The gated runner cleans up automatically when `SWITCHYARD_REMOTE_DAYTONA_KEEP` is unset:

- closes the PR whose head branch belongs to the run
- deletes only the allowed-prefix branch for the scratch issue
- marks or parks only the scratch fp issue created for the run
- deletes only Daytona sandboxes labelled with the run's `test_run_id`

The runner refuses broad cleanup. A missing `test_run_id` is a hard error.

## Manual Inputs

Capture these values from runner output or from the sanitized result file:

```text
test_run_id
scratch issue display id
branch
pr_number
sandbox_id
```

## Manual Cleanup Checklist

1. Close only the PR whose head branch equals the run branch.
2. Delete only that GitHub branch.
3. Inspect the scratch fp issue and leave implementation siblings untouched.
4. Delete only Daytona sandboxes with all of these labels:
   `app=symphony-test`, `source=remote-daytona`, `test_run_id=<test_run_id>`.
5. Re-run the E2E helper or Daytona listing to confirm no matching sandboxes remain.

## Forensics

Set `SWITCHYARD_REMOTE_DAYTONA_KEEP=1` before a run when you need to inspect the sandbox or PR.
Do not commit raw transcripts, fp JSON, PR JSON, command logs, or `.env`-derived output. Commit
only curated, secret-scanned PASS evidence under `packages/qa/results/`.
