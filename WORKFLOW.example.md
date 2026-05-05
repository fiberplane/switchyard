# Workflow config — annotated example
#
# Copy this file to ./WORKFLOW.md (the orchestrator's default load path; see
# `apps/symphony-orchestrator/src/index.ts` parseCliOptions) and fill in the
# stack-specific fields marked `<…>` below. The orchestrator does not
# interpolate `$VAR` placeholders inside YAML — substitute at file-edit time.
#
# Field shape: apps/symphony-orchestrator/src/workflow/models.ts
# Loader:     apps/symphony-orchestrator/src/workflow/loader.ts

# tracker — where the orchestrator polls for ready issues.
#
# `kind: fp` is the only supported tracker today. `dispatchFilter` selects
# which fp issues are eligible for dispatch; the runtime does an AND of
# `status=todo` (built-in) with the property match below.
tracker:
  kind: fp
  dispatchFilter:
    property: symphony_ready
    value: "true"

# polling — how often the tracker is queried for new work.
polling:
  intervalMs: 5000

# agent — concurrency and retry policy for in-flight runs.
#
# `maxAttempts` is locked at 1 for v1 (ADR D5); auto-retry is deferred.
# `maxConcurrentAgents` caps how many issues can be in-flight at once;
# v1 is single-flight in practice but the schema allows higher values.
agent:
  maxConcurrentAgents: 1
  maxAttempts: 1

# sandbox — the Daytona target.
#
#   apiUrl   — Base URL of your Daytona API. Local OSS install defaults to
#              http://localhost:3000/api.
#   apiKey   — Dashboard-issued admin key. Bring up Daytona, log into the
#              dashboard, create an API key, paste here. Local-only auth — the
#              key only authorizes access to your localhost Daytona.
#   target   — Daytona target name; `us` is the standard local default
#              (per spec line 89; not "local").
#   snapshot — Sandbox snapshot. `symphony-codex-bun` is the canonical local
#              snapshot (Ubuntu 22.04 + node + bun + git + codex@0.128.0); see
#              the smoke playground README for build instructions. Must be
#              `active` (not `pending`) before dispatch.
#
# `autoStopInterval`/`autoDeleteInterval` control sandbox lifecycle:
#   - `autoStopInterval: 15` — Daytona stops the sandbox 15min after the run
#     ends. Good default for local cleanup.
#   - `autoDeleteInterval: -1` — never auto-delete, leaves the stopped sandbox
#     around for forensic SSH. Manual cleanup via the dashboard or
#     `daytona sandbox delete`. Tracked by SWYRD-xlgiuegf.
#
# `repoPath`, `sourceStrategy`, `artifactStrategy` are stable conventions; do
# not change unless you know why.
sandbox:
  kind: daytona
  apiUrl: <DAYTONA_API_URL>
  apiKey: <DAYTONA_API_KEY>
  target: <DAYTONA_TARGET>
  snapshot: <DAYTONA_SNAPSHOT>
  language: typescript
  autoStopInterval: 15
  autoDeleteInterval: -1
  repoPath: /workspace/repo
  sourceStrategy: archive
  artifactStrategy: bundle

# codex — the worker runtime spawned inside the sandbox.
#
# `command: codex app-server` is the only supported entrypoint today.
# `turnTimeoutMs: 3600000` is the per-turn deadline (locked in osqltjnr §7).
# `approvalPolicy`, `sandbox`, and `sandboxPolicy` are optional and decode to
# `"never"`, `"danger-full-access"`, and `{ type: "dangerFullAccess" }`
# (see workflow/models.ts:50-62). Override only if a derived scenario needs
# different values — protocol-shape assertions in QA scenarios depend on the
# defaults.
codex:
  command: codex app-server
  turnTimeoutMs: 3600000

# integration — how worker output is woven back into the host repo.
#
# `branchPrefix` is prepended to the issue's internal id when the orchestrator
# creates the integrated branch (e.g., `symphony/<id>`).
integration:
  branchPrefix: symphony/
