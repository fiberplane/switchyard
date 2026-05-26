# Setup Workflow Config

## Goal

Materialize a working `WORKFLOW.md` (or `workflow.yaml`) at the host repo's root with concrete
values that the orchestrator's loader will accept. This is the file the orchestrator reads at
boot via `--workflow <path>` (default: `./WORKFLOW.md`; see ozdpzajz §3 / index.ts CLI flag).

## Background

The schema lives at `apps/symphony-orchestrator/src/workflow/models.ts`. `WorkflowConfig`
contains six top-level groups: `tracker`, `polling`, `agent`, `sandbox`, `codex`, `integration`.
Decoding is YAML-only via `parseYaml` then `Schema.decodeUnknown(WorkflowConfig)` (see
`apps/symphony-orchestrator/src/workflow/loader.ts`).

**Critical:** the workflow is tracked and secret-free. Daytona credentials and optional SDK
overrides come from `apps/symphony-orchestrator/.env` or the host shell, not YAML. The orchestrator
does not interpolate `$VAR` placeholders in workflow YAML.

The `decodeDaytonaConfigEnv` function at
`apps/symphony-orchestrator/src/daytona/models.ts:118` is for a separate code path (env-only
Daytona config); index.ts uses host runtime config plus the WORKFLOW.md sandbox snapshot via
`toDaytonaConfig(config.sandbox, hostRuntimeConfig)`.

## What needs to happen

1. Copy `packages/qa/fixtures/workflow-sample.yaml` to the host repo root as `WORKFLOW.md`.
2. Substitute `<DAYTONA_SNAPSHOT>` if the default snapshot name differs from the sandbox image you
   prepared.
3. (Optional) Adjust `polling.intervalMs` if you want a tighter loop for QA observation. Default
   in the fixture is 5000ms.
4. Verify the file decodes cleanly.

## Host Environment

Put secrets in `apps/symphony-orchestrator/.env` or export them in the shell that starts the
orchestrator:

```
DAYTONA_API_KEY=<daytona-api-key>
# Optional SDK overrides for non-default Daytona endpoints/targets:
DAYTONA_API_URL=http://localhost:33000/api
DAYTONA_TARGET=us
DAYTONA_SNAPSHOT=symphony-test-codex
```

Values from the real process environment win over `apps/symphony-orchestrator/.env`.

## Where to look in the codebase

- `apps/symphony-orchestrator/src/workflow/models.ts` — the schema. **Drift target for any
  scenario or helper that embeds workflow YAML shape.**
- `apps/symphony-orchestrator/src/workflow/loader.ts` — the YAML parse + schema decode
  pipeline.
- `apps/symphony-orchestrator/src/workflow/errors.ts` — `WorkflowFileMissing` and
  `WorkflowDecodeError` (both `Data.TaggedError`); the orchestrator surfaces these via the
  structured logger on boot failure.
- `apps/symphony-orchestrator/test/fixtures/workflow.valid.yml` — reference shape.

## How to verify

The cheapest verification is a dry run of the loader:

1. From the host repo CWD, attempt to boot the orchestrator with `--workflow ./WORKFLOW.md`.
2. If the YAML is malformed: log emits a `WorkflowDecodeError` with the failing field path.
3. If the file is missing: log emits a `WorkflowFileMissing` with the resolved path.
4. If the YAML decodes but the Daytona environment values are wrong: the boot succeeds, but the first
   `runOne` (or even sandbox probe in `DaytonaAdapterLive` if `probeOnInit: true`) fails with a
   Daytona transport/auth error.

## Required field shape (informational)

```yaml
tracker:
  kind: fp
  dispatchFilter:
    property: symphony_ready
    value: "true"
polling:
  intervalMs: 5000
agent:
  maxConcurrentAgents: 1
  maxAttempts: 1 # locked at 1 for v1 (no auto-retry; see ADR D5)
sandbox:
  kind: daytona
  snapshot: <concrete SNAPSHOT, no $VAR>
  language: typescript
  autoStopInterval: 15
  autoDeleteInterval: -1 # never auto-delete (see SWYRD-xlgiuegf for v2 follow-up)
  repoPath: /workspace/repo
  sourceStrategy: archive
  artifactStrategy: bundle
codex:
  command: codex app-server
  turnTimeoutMs: 3600000 # 1 hour per-turn deadline (locked in osqltjnr §7)
  # approvalPolicy, sandbox, sandboxPolicy: optional; default to "never",
  # "danger-full-access", and { type: "dangerFullAccess" } via schema (see
  # apps/symphony-orchestrator/src/workflow/models.ts:50-62). Override only
  # if a derived scenario needs different values.
integration:
  branchPrefix: symphony/
```

## Cleanup

The materialized `WORKFLOW.md` lives in the host repo; remove it as part of host-repo cleanup
(per `helpers/setup-host-repo.md` and `helpers/cleanup.md`).

The fixture template at `packages/qa/fixtures/workflow-sample.yaml` stays put — it's the
template, not a per-run artifact.
