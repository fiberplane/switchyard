# Daytona Cloud Lifecycle Smoke

Date: 2026-05-26
Issue: `SWYRD-mfwjlwio`
Status: Passed for the Cloud lifecycle path, including optional fp REST read.

## Environment

- Daytona Cloud API key was loaded from the gitignored orchestrator env file.
- Snapshot used for the passing run: `switchyard-codex-bun-20260526`.
- Remote test gate: `SWITCHYARD_REMOTE_DAYTONA_TEST=1`.
- Remote test sandboxes used canonical labels: `app=symphony-test`,
  `source=remote-daytona`, `created_at_ms`, `owner`, and a per-run `test_run_id`.
- Optional fp read gate: `SWITCHYARD_REMOTE_DAYTONA_FP_SMOKE=1`.
- Optional fp issue: `SWYRD-mfwjlwio`.

## What Ran

Command:

```bash
SWITCHYARD_REMOTE_DAYTONA_TEST=1 \
SWITCHYARD_REMOTE_DAYTONA_FP_SMOKE=1 \
SWITCHYARD_REMOTE_DAYTONA_FP_ISSUE=SWYRD-mfwjlwio \
DAYTONA_SNAPSHOT=switchyard-codex-bun-20260526 \
bun test apps/symphony-orchestrator/test/daytona/remote-cloud.test.ts
```

Result:

- 9 pass, 0 fail, 27 expect calls.
- Snapshot listing succeeded and the configured snapshot was active.
- Sandbox create succeeded with canonical remote test labels.
- Tool verifier found `git`, `gh`, `fp`, `rg`, `bash`, `curl`, `jq`, Bun, Codex, drift, and ast-grep.
- Command execution succeeded.
- Upload/download round-tripped a tiny file by SHA-256.
- Sandbox-side scan found no `DAYTONA_API_KEY` environment variable or durable name/content marker.
- Host-side exact-value scan found no Daytona API key in captured smoke outputs.
- `DaytonaSession` streaming passed with the existing exit-trap behavior.
- Optional fp read smoke ran inside the sandbox with `FP_REMOTE=rest-api` and parsed issue JSON with
  `jq`; no fp token appeared in captured output.
- Test cleanup created a dedicated cleanup sandbox, selected it by canonical labels, deleted it,
  and confirmed `listRemoteTestSandboxes` returned empty for the `test_run_id`.

## Red Evidence

The Nocturne snapshots `fp-nocturne-dev-20260525-v3` and `fp-nocturne-dev-20260525-v4`
were active but failed the Switchyard verifier because `codex` was missing. That is why this
ticket now builds and verifies the Switchyard-specific snapshot.

The first Cloud session smoke showed the previous 5 second input-pipe readiness timeout was too
short for Cloud. Later remote E2E runs increased the readiness wait to 120 seconds and added an
early command-exit check while keeping the exit-trap protocol unchanged.
