# Setup Daytona Test Stack

## Goal

Bring up the local Daytona OSS compose stack used by the vertical-slice scenarios so the
orchestrator has a real Daytona target to dispatch sandboxes into.

## What needs to happen

The switchyard repo already vendors the test stack at
`apps/symphony-orchestrator/test/daytona/`. The integration test in `osqltjnr` calls it
automatically; for QA scenarios you bring it up yourself.

1. Ensure Docker (or Docker Desktop) is running.
2. Bring the stack up via the orchestrator workspace's `test:daytona:up` script. The script
   wraps `docker compose -p switchyard-test ...` and auto-applies the macOS DNS overlay on
   Darwin (see `helpers/macos-host-fixes.md`).
3. Confirm the API and proxy are reachable.
4. Provision (or reuse) a local admin API key.
5. Confirm the configured snapshot exists and is `active` (not `pending`).
6. Capture the resolved env values that scenarios will use:
   `DAYTONA_API_URL`, `DAYTONA_API_KEY`, `DAYTONA_TARGET`, `DAYTONA_SNAPSHOT`.

## Where to look in the codebase

- `apps/symphony-orchestrator/test/daytona/README.md` — full stack docs (port mapping, macOS
  DNS workaround, snapshot mechanics, troubleshooting). **Read this first.**
- `apps/symphony-orchestrator/test/daytona/compose.test.yaml` — the canonical compose file.
- `apps/symphony-orchestrator/test/daytona/compose.test.macos.yaml` — macOS overlay.
- `apps/symphony-orchestrator/test/daytona/Dockerfile.snapshot` — the `symphony-test-codex`
  snapshot used by integration tests.
- `apps/symphony-orchestrator/package.json` — the `test:daytona:up` / `test:daytona:down`
  scripts.

## Snapshot to use

The QA scenarios use the `symphony-test-codex` snapshot (per spec `### Smoke Evidence`,
2026-05-04, lines 96-101) — Ubuntu 22.04 with `git`, `curl`, `ca-certificates`, `bash`, `jq`,
`ripgrep`, `procps`, `@openai/codex@0.128.0`, and `bun@1.3.13`.

If `symphony-test-codex` does not exist on your local Daytona target, build it the same way the
2026-05-04 smoke did. The image is **separate** from the integration test's `symphony-test-codex`
snapshot; the test stack defines its own minimal snapshot for adapter / session unit tests, and
QA scenarios use the codex-equipped one.

## Codex CLI version pinning

Scenarios target `codex app-server` from `@openai/codex@0.128.0` (per spec line 100; the protocol
shapes documented at lines 200-222 are verified against this exact version). Newer codex-cli
versions may produce different protocol output and break scenarios silently — when authoring or
re-running a scenario, capture the version actually used in the result file. Version drift is
the most likely cause of "scenario worked yesterday, fails today" reports.

## How to verify the stack came up

- The Daytona dashboard at `http://localhost:33000` returns HTTP 200.
- `GET http://localhost:33000/api/health` returns `{"status":"ok"}`.
- A bare API call with the admin key authenticates (the dashboard's own request panel is fine).
- The configured snapshot lists as `active`, not `pending`.
- On macOS, `host anything.proxy.127.0.0.1.nip.io` resolves to `127.0.0.1` (the load-bearing
  resolver path; see `helpers/macos-host-fixes.md` if it doesn't).
- The runner is healthy (its score above the schedulability threshold; see the test stack
  README's troubleshooting notes for `region_quota` and runner-availability fixes).

## Env values to capture

After the stack is up, capture and export:

```
DAYTONA_API_URL    # e.g. http://localhost:33000/api
DAYTONA_API_KEY    # the admin key generated inside the api container (mode-600 file outside repo)
DAYTONA_TARGET     # e.g. us  (per spec line 89; not "local")
DAYTONA_SNAPSHOT   # symphony-test-codex
```

These flow into `helpers/setup-workflow-config.md` to materialize a `WORKFLOW.md` with concrete
values (the orchestrator does **not** interpolate `$VAR` placeholders in YAML — see ADR / spec
lines 415-420 and the `setup-workflow-config` helper).

## Cleanup

The stack persists across scenario runs. Bring it down only when you're done with the QA pass:

- Tear down via the workspace's `test:daytona:down` script.
- The script reclaims volumes (the dashboard's stored projects and runner DB).
- Sandboxes created during scenarios are NOT auto-deleted because v1 sets
  `autoDeleteInterval: -1` (see fixture `workflow-sample.yaml`); list and prune manually if you
  want a clean slate. See `helpers/cleanup.md`.
