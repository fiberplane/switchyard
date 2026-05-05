# Setup Host Repo

## Goal

Initialize an isolated host git repository for the orchestrator to integrate into. The
orchestrator fetches the worker's `git bundle` into this repo as a `symphony/<issue-id>` branch
(per spec `### Sandbox-to-Host Code Transfer`, lines 634-660 of
`docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md`).

## What needs to happen

1. Create a temporary directory outside the switchyard repo (so the orchestrator's `.symphony/`
   workspace doesn't collide with this repo's tracked files).
2. `git init` the directory and configure a test git identity.
3. Seed it with at least one real commit so `git rev-parse HEAD` succeeds (the orchestrator's
   integration step needs a base SHA at dispatch time — `OrchestratorRecord.baseRev`, see
   `apps/symphony-orchestrator/src/artifact/models.ts`).
4. Optionally seed a small file the worker's task can modify (the happy-path scenario expects a
   `README.md` to append a line to — see fixtures/`sample-code-task.md`).

## Why outside the switchyard tree

- The orchestrator runs from this host repo's CWD, and writes run records under
  `<CWD>/.symphony/runs/<issue-id>/<attempt>/` (see ozdpzajz §3 pseudocode and
  `apps/symphony-orchestrator/src/artifact/store.ts`).
- Running from the switchyard tree itself would mix QA artifacts into the development workspace
  and confuse `lint:drift`. Isolation is cheap; do it.

## What the orchestrator expects of this repo

- It must be a git repo (`git rev-parse --git-dir` succeeds at the CWD).
- It must have at least one commit reachable from `HEAD` (so `baseRev` resolves).
- It must NOT already have a `symphony/<issue-id>` branch for the issue being dispatched (the
  integration step refuses to overwrite existing branches per spec lines 644-648; on collision
  it creates `symphony/<issue-id>-attempt<N>` instead).
- It does NOT need to be pushable, public, or hosted anywhere. The orchestrator only does local
  branch creation; pushing is out of scope.

## Layout (load-bearing for scenario 01)

Use `/tmp/swyrd-qa-host-<timestamp>/` as the host-repo path; scenarios reference this path as
canonical. If you choose a different location, substitute it everywhere `<host-repo>` appears
in `scenarios/01-vertical-slice-happy-path.md`.

```
/tmp/swyrd-qa-host-<timestamp>/
├── .git/
├── README.md          # something for the worker to modify
└── (optional) src/    # if your task fixture exercises a non-trivial code change
```

Keep the repo small. The full repo is `git archive`d at dispatch (per spec lines 561-566) and
uploaded to the sandbox; large repos slow the loop.

## How to verify

- `git rev-parse HEAD` resolves to a real SHA.
- `git status` is clean.
- The directory is outside `apps/`, `packages/`, and any other tracked switchyard tree.
- No `.symphony/` directory exists yet (the orchestrator creates it on first run).

## Cleanup

After the QA pass:

- Capture the host SHA (`git log --oneline`) and any `symphony/*` branches into the result file
  if the run is worth preserving.
- Remove the entire temp directory tree. The orchestrator's `.symphony/runs/` lives under it,
  so cleaning the host repo cleans run records too.
