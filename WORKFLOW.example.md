# Workflow config — annotated example
#
# Copy this file to ./WORKFLOW.md (the orchestrator's default load path; see
# `apps/symphony-orchestrator/src/index.ts` parseCliOptions) and fill in the
# non-secret policy fields below. Daytona, GitHub, fp, and Codex credentials
# live in apps/symphony-orchestrator/.env or the host process environment, not
# this tracked workflow file.
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
# `DAYTONA_API_KEY` is required in host env. `DAYTONA_API_URL` and
# `DAYTONA_TARGET` are optional host-env overrides for non-default Daytona SDK
# endpoints/targets. `DAYTONA_SNAPSHOT` may override `snapshot` below.
#
# `snapshot` is the default sandbox snapshot name. It must be active before
# dispatch.
#
# `autoStopInterval`/`autoDeleteInterval` control sandbox lifecycle:
#   - `autoStopInterval: 15` — Daytona stops the sandbox 15min after the run
#     ends. Good default for local cleanup.
#   - `autoDeleteInterval: -1` — never auto-delete, leaves the stopped sandbox
#     around for forensic SSH. Manual cleanup via the dashboard or
#     `daytona sandbox delete`. Tracked by SWYRD-xlgiuegf.
#
# `repoPath` is the checkout path inside the sandbox.
#
# `sourceStrategy: githubClone` tells the orchestrator to pass clone metadata
# into the sandbox instead of uploading a host archive. `artifactStrategy: pr`
# means the worker owns branch push, PR creation, and fp terminal metadata. The
# host verifies the PR/fp/sandbox read-back rather than downloading a bundle.
#
# `repoUrl` must be a clean HTTPS GitHub URL with no embedded credentials.
# `baseBranch` is fetched and resolved to a pinned SHA before dispatch. Override
# it when validating a feature branch; use `main` for normal operator runs.
sandbox:
  kind: daytona
  snapshot: <DAYTONA_SNAPSHOT>
  language: typescript
  autoStopInterval: 15
  autoDeleteInterval: -1
  repoPath: /workspace/repo
  sourceStrategy: githubClone
  artifactStrategy: pr
  repoUrl: https://github.com/fiberplane/switchyard.git
  baseBranch: main

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

# integration — worker branch naming.
#
# `branchPrefix` prefixes deterministic worker-owned PR branches. The remote
# path validates the final branch through fp/GitHub metadata before it reports
# the run as integrated.
integration:
  branchPrefix: symphony/
