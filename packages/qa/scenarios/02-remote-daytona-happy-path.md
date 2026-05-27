---
name: Remote Daytona Happy Path
requires:
  [
    remote-daytona-env,
    remote-fp-rest,
    remote-github-pr,
    remote-daytona-cleanup,
  ]
---

# Remote Daytona Happy Path

## Goal

Verify the remote Daytona PR-owned path end to end:

fp scratch issue -> Daytona Cloud sandbox -> GitHub clone at pinned base SHA -> worker branch
push -> non-draft PR -> worker-owned fp terminal metadata -> host-side fp/GitHub/Daytona
agreement checks -> cleanup.

This scenario supersedes the local archive/bundle verification shape for remote runs. Scenario
01 remains as historical local-compose coverage until the local Daytona retirement ticket removes
it.

## Prerequisites

- `apps/symphony-orchestrator/.env` exists and is gitignored.
- Required env values are present:
  - `SWITCHYARD_REMOTE_DAYTONA_E2E=1`
  - `DAYTONA_API_KEY`
  - `DAYTONA_SNAPSHOT`
  - `GITHUB_TOKEN`
  - `FP_REMOTE=rest-api`
  - `FP_TOKEN`
  - `FP_SERVER_URL`
  - `FP_WORKSPACE`
  - `FP_PROJECT_ID`
  - `SWITCHYARD_CODEX_AUTH`
- For GitHub fine-grained PATs, `GITHUB_TOKEN` grants contents read/write, workflows read/write,
  and pull requests read/write access to the target repository.
- The configured Daytona snapshot contains `git`, `gh`, `fp`, `rg`, `jq`, Bun, Codex, drift,
  and ast-grep.
- The configured base branch exists on GitHub. Override with
  `SWITCHYARD_REMOTE_DAYTONA_BASE_BRANCH=<branch>` when validating this feature branch before it
  is merged.

## Steps

### 1. Run the gated E2E

**Action:**

```bash
bun run --filter @switchyard/qa remote-daytona:e2e
```

**Expected:**

- Without `SWITCHYARD_REMOTE_DAYTONA_E2E=1`, the runner prints a skip message and exits without
  creating fp, GitHub, or Daytona resources.
- With the gate enabled, the runner prints a `test_run_id`, a sanitized env summary, and a
  scratch fp issue id.

**Verify:**

- No secret values are printed.
- The scratch issue title starts with `remote daytona e2e <test_run_id>`.

### 2. Verify worker-owned completion

**Action:**

Inspect the runner output and the scratch issue.

**Expected:**

- The orchestrator returns an integrated local result only after fp read-back shows
  `status=done`, `symphony_state=end`, and all canonical PR metadata.
- The worker branch starts with the allowed prefix, default `symphony/e2e/`.
- No `work.bundle`, `outcome.json`, or `symphony_artifact` is used by the remote path.

**Verify:**

- `symphony_branch` matches the GitHub PR head branch.
- `symphony_pr_url` and `symphony_pr_number` match `gh pr view`.
- `symphony_base_sha` matches the PR base ref SHA.
- `symphony_head_sha` matches the PR head ref SHA.
- `symphony_run_id` and `symphony_sandbox_id` are present.

### 3. Verify Daytona labels and cleanup

**Action:**

Let the runner finish cleanup, or set `SWITCHYARD_REMOTE_DAYTONA_KEEP=1` before running if you
need forensics.

**Expected:**

- The sandbox labels include `app=symphony-test`, `source=remote-daytona`, and the exact
  `test_run_id`.
- Cleanup deletes only sandboxes matching those labels.
- PR cleanup closes only the matching PR and deletes only the allowed-prefix branch.

**Verify:**

- With keep disabled, `listE2ESandboxes` finds no sandboxes for the test run after cleanup.
- With keep enabled, the runner prints that artifacts were intentionally kept.

## Evidence

The runner writes a sanitized result file to:

```text
packages/qa/results/remote-daytona-e2e-<test_run_id>.md
```

Commit one result with `git add -f` only when it captures a canonical run. Do not commit raw
transcripts, raw fp JSON, raw PR JSON, command logs, or `.env`-derived output.

## Cleanup

If manual cleanup is needed:

- Close only the PR whose head branch starts with the allowed prefix and whose scratch issue title
  contains the `test_run_id`.
- Delete only that branch.
- Delete only Daytona sandboxes whose labels match
  `app=symphony-test`, `source=remote-daytona`, `test_run_id=<test_run_id>`.
- Leave implementation tickets and parent epics untouched.
