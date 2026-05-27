# @switchyard/qa — vertical-slice end-to-end QA

Operator-followable scenarios that exercise the Switchyard vertical slice end-to-end against a
real Daytona stack, real `fp` issues, real `codex app-server`, and a real host repo. Sibling
deliverable to `apps/symphony-orchestrator/test/orchestrator/service.integration.test.ts` — the
integration test proves the wiring works under controlled conditions; this package is what an
operator follows when running the system fresh and needs to know what "working" looks like at
every layer.

Modeled on `references/nocturne/packages/qa-scripts/` (or your local clone at
`../nocturne/packages/qa-scripts/`). Read its README first if you've never worked with this style
of QA package — the conventions there are load-bearing.

## Philosophy

- **Descriptive scenarios, not scripts.** Each scenario describes the goal, the steps, and how to
  verify success. Helpers describe _what_ needs to happen, not _how_ — the operator (or agent)
  reads the helper, explores the codebase to find the right commands, then executes.
- **Real surfaces only.** The package's value is being end-to-end. Mocked / synthetic happy paths
  belong in `service.integration.test.ts`, not here.
- **Drift-anchored where it counts.** Scenarios that cite concrete command/property/log surfaces
  have `drift link`s to the source files whose behavior the snippet depends on. Pure-prose
  scenarios skip drift; see "Drift conventions" below.

## Structure

```
packages/qa/
├── README.md           # this file
├── package.json        # workspace anchor
├── .gitignore          # ignores results/ output
├── helpers/            # what-to-do descriptions, agent-readable
├── scenarios/          # numbered, frontmatter-tagged walkthroughs
├── fixtures/           # ready-to-copy WORKFLOW.md + fp-issue bodies
└── results/            # operator-captured run logs (gitignored)
```

## Scenario index

| #   | Scenario                                                                 | Covers                                                                         |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 01  | [Vertical slice — happy path](scenarios/01-vertical-slice-happy-path.md) | Code-change task → `symphony/<id>` branch → fp `done`; structured-log contract |
| 02  | [Remote Daytona — happy path](scenarios/02-remote-daytona-happy-path.md) | Daytona Cloud sandbox → GitHub PR → worker-owned fp metadata → cleanup         |

Scenario 01 is the v1 demo-readiness signal — happy-path success is what proves the slice
works end-to-end.

Scenario 02 is the remote-Daytona migration signal. It is gated by
`SWITCHYARD_REMOTE_DAYTONA_E2E=1` and is intentionally not wired into `bun run test`.
Before it creates fp issues or Daytona sandboxes, the harness verifies that the configured
`GITHUB_TOKEN` can create and delete an E2E-prefixed branch in the target repo. For GitHub
fine-grained PATs, grant contents read/write, workflows read/write, and pull requests read/write
access to the repo. GitHub may require workflow write permission when creating a branch at a commit
that already contains `.github/workflows`.

Before spending a Daytona run, validate a new PAT with:

```bash
bun run --filter @switchyard/qa github-token:preflight
```

The preflight loads `apps/symphony-orchestrator/.env`, prints only token fingerprints, checks for
ambient `process.env` override, and tries both REST create/delete-ref and isolated
credential-helper-free `git push` create/delete under `symphony/e2e/`.

**Failure-path scenarios deferred to follow-up `SWYRD-euvkxyra`** (under epic `SWYRD-uouprnfv`):
worker-blocked (02), research-task (03), re-arm (04), and signal-shutdown (05). Failure-mode
behavior is covered at unit level by `osqltjnr`'s `service.integration.test.ts` (cycles 4-7 +
12c); operator-followable forensics docs are nice-to-have, not v1-gating. Any of the four can
be promoted in-place when a real incident provides higher-fidelity evidence than a guessed-up
walkthrough would.

## Helpers

| Helper                                                             | Purpose                                                                           |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| [setup-daytona-test-stack.md](helpers/setup-daytona-test-stack.md) | Bring up the local Daytona OSS compose stack                                      |
| [setup-host-repo.md](helpers/setup-host-repo.md)                   | Initialize a temp host repo as the integration target                             |
| [bootstrap-codex-auth.md](helpers/bootstrap-codex-auth.md)         | Get `~/.codex/auth.json` into the sandbox snapshot                                |
| [create-fp-issue.md](helpers/create-fp-issue.md)                   | Craft an `fp` issue with the right `symphony_*` properties                        |
| [setup-workflow-config.md](helpers/setup-workflow-config.md)       | Materialize a working `WORKFLOW.md` from the fixture                              |
| [cleanup.md](helpers/cleanup.md)                                   | Tear down the stack + prune sandboxes + optional run-record cleanup               |
| [macos-host-fixes.md](helpers/macos-host-fixes.md)                 | macOS DNS workaround for `*.proxy.localhost` (now upstreamed; kept as a footnote) |

Helpers describe the _what_. The operator (or agent) reads the helper, explores the codebase to
find the right commands, and executes. This is the load-bearing convention from nocturne.

## Drift conventions

Scenarios that cite specific command flags, `symphony_*` property values, log key names, file-layout
facts, or canonical error sentinels get a `drift link`. The link's job is to fail `bun run lint:drift`
when the underlying source moves so the scenario prose can be reviewed before it silently rots.

Anchor patterns to apply:

| Scenario surface                        | Drift link target                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `fp issue create --property symphony_*` | `apps/symphony-orchestrator/src/fp/symphony-properties.ts`                                      |
| `WORKFLOW.md` field shape               | `apps/symphony-orchestrator/src/workflow/models.ts`                                             |
| Canonical `symphony_last_error` strings | `apps/symphony-orchestrator/src/orchestrator/service.ts`                                        |
| Structured-log key set                  | `apps/symphony-orchestrator/src/observability/logger.ts` + `docs/architecture/observability.md` |
| `bun run start` invocation shape        | `apps/symphony-orchestrator/src/index.ts`                                                       |
| Worker prompt contract assertions       | `apps/symphony-orchestrator/src/prompt/template.ts`                                             |

Skip drift on scenarios that only describe operator UX flow at a high level. Add anchors via
`drift link <doc> <code>` from the repo root; never edit `drift.lock` by hand. See
`docs/patterns/drift.md` (or the docs/README.md drift section) if you've never run it.

## Running a scenario

Generic flow:

1. Read the scenario's `requires:` list and load each helper.
2. Read any chained scenario in `depends-on:` and confirm prerequisites still hold.
3. Read the scenario top-to-bottom before executing — don't run blind.
4. Execute Steps in order. Capture command output as you go.
5. Run the Verify checks at each step before moving on.
6. On completion, record results under `results/YYYY-MM-DD-HHMM-<scenario-slug>.md`. Result files
   are gitignored by default; commit one with `git add -f` if it captures a useful walkthrough.
7. Run the scenario's Cleanup (or the shared `helpers/cleanup.md`).

## Results

`results/` is gitignored. Operators capture walkthroughs locally; commit a result file with
`git add -f` only when it documents a canonical run worth preserving (e.g., the first successful
end-to-end happy-path log after a major change).

Result file format:

```markdown
# Result: <Scenario Name>

**Date:** YYYY-MM-DD HH:MM
**Status:** PASS | FAIL
**Branch:** <git branch>
**Commit:** <short SHA>

## Steps

### 1. <step name>

**Status:** PASS | FAIL
**Output:**
\`\`\`
captured output
\`\`\`

## Summary

Notes about the run, any deviations, follow-up items.
```

## Out of scope (v1)

- **Automated test harness.** Scenarios are operator-followable, not bun-test fixtures.
- **CI integration.** Running scenarios in CI is a follow-up if anyone asks for it.
- **Concurrency-cap testing.** v1 is single-flight; concurrency comes back when
  `agent.maxConcurrentAgents > 1` lands.
- **Recovery / restart scenarios.** Recovery is deferred globally for v1 (see ADR D2 / D5).
- **Performance / runtime budgeting.** Scenarios may note approximate durations but don't measure
  or assert.

## Related

- Umbrella spec: `docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md`
- ADR: `docs/architecture/0001-symphony-deviations.md`
- Orchestrator service ticket (locked behaviors): `SWYRD-osqltjnr`
- Index.ts ticket: `SWYRD-ozdpzajz`
- This package's parent ticket: `SWYRD-aojxuuft`
- Nocturne reference: `../nocturne/packages/qa-scripts/`
