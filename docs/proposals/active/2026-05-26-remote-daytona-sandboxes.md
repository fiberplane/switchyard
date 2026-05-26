# Remote Daytona Sandboxes

Status: Draft
Date: 2026-05-26

## Agreed Decisions

### A1. Production Sandboxes Stay Forensic By Default

Production remote Daytona runs preserve the current `orchestrator-runone.md` contract: `runOne`
does not proactively delete sandboxes. Runtime cleanup is handled by Daytona auto-stop/delete
settings and a separate label-based sweeper. Tests and explicit smoke scripts may delete
sandboxes in `finally` paths unless `--keep-sandbox` is set.

### A2. `WORKFLOW.md` Stays Tracked And Secret-Free

`WORKFLOW.md` remains a tracked operator policy file, but it must not contain Daytona or GitHub
credentials. `sandbox.apiKey` is removed from the schema and tracked examples. The loader must
fail loudly if a workflow file still contains `sandbox.apiKey`; removing the schema field alone
is insufficient because Effect Schema's struct decoding can ignore unknown keys. Daytona
credentials come from host-side secret ingestion.

The implementation should take inspiration from `~/fiber/bb-libs/symphony`: resolve secrets from
canonical environment variables, allow `$VAR` indirection only for fields that intentionally
support it, treat empty secret env values as missing, and validate presence without printing the
secret value. For Daytona/GitHub credentials specifically, prefer no workflow field at all; the
canonical host env is the source.

### A3. Secrets May Come From Host Env Or Gitignored `.env`

Support both exported host environment variables and a gitignored
`apps/symphony-orchestrator/.env` file. `process.env` wins over `.env` when both define a key.
Track `.env.example`; never copy `.env` into the sandbox and never persist its values in
workflow files, logs, transcripts, fp comments, or artifacts.

### A4. The Worker Owns Branch, PR, And fp Completion

Remote Daytona should follow the Nocturne issue-to-PR shape: the sandbox clones the repo from
GitHub, receives scoped fp REST and GitHub credentials, creates a branch, opens a PR with `gh`,
updates fp with branch/PR metadata, babysits the PR, and marks the issue done or blocked. The
orchestrator no longer downloads a code artifact, creates a host branch, or performs host-side
bundle integration for this path.

This supersedes the current archive/bundle demo contract for the remote path. It intentionally
relaxes ADR 0001 D4 for scoped fp writes from the sandbox and replaces ADR 0001 D7's bundle
artifact with a PR artifact.

The first implementation should remove host-side code artifact return for the remote path. The
durable code artifact is the worker-created GitHub PR, with branch, PR, base SHA, and head SHA
stored on the fp issue.

### A5. Local Daytona Compose Is Removed In The Same Bout

Remove the local Daytona OSS/docker-compose implementation in the same implementation bout, not as
a long-lived fallback. The deletion should happen after remote-gated verification exists and after
the old compose implementation has been documented in `docs/graveyard/`, so historical knowledge
is retained without keeping active maintenance surface.

### A6. Worker Credentials Are Scoped But Real

The remote worker gets scoped fp REST and GitHub write credentials as process env for the task
session. This is required for the sandbox-owned issue-to-PR workflow and intentionally supersedes
ADR 0001 D4 for the remote path. Credentials must not be sandbox create-time env, repo files,
shell profiles, git remotes, PR text, fp comments, or diagnostic artifacts.

### A7. PR Metadata Properties Are Canonical

Canonical fp metadata for PR-owned completion is `symphony_branch`, `symphony_pr_url`,
`symphony_pr_number`, `symphony_base_sha`, `symphony_head_sha`, `symphony_run_id`, and
`symphony_sandbox_id`. Remove `symphony_artifact`; this POC does not need compatibility with the
old local artifact path.

### A8. End With Fallow, Dead-Code Removal, And Full Review Gates

After remote Daytona is implemented and local Daytona compose is retired, add a terminal cleanup
pass modeled on Nocturne's Fallow setup. Fallow findings are triage evidence, not automatic
deletion authority: remove only clearly identifiable dead code after the architecture switch. A
separate final closeout pass then reruns Fallow, runs an adversarial code-quality review loop until
no actionable findings remain, runs root health checks and remote E2E, performs secret scans, and
opens the GitHub PR.

## Problem

Switchyard currently dispatches workers into a local Daytona OSS compose stack. That was the
right shape for the meetup vertical slice, but it creates the wrong operator model now that we
have Daytona Cloud API access:

- Every developer has to run and repair a multi-service local Daytona stack before a real
  orchestrator run.
- The committed docs instruct operators to paste a Daytona key into `WORKFLOW.md`, even though
  `WORKFLOW.md` is tracked.
- The source handoff still uses host `git archive` upload, so the sandbox sees a synthetic
  single-commit history rather than the GitHub repository it should work in.
- Local Docker Compose details are mixed into active architecture docs, test helpers, app
  scripts, and QA scenarios.

The target state is a host-side orchestrator that creates Daytona Cloud sandboxes through the
SDK, clones the repository from GitHub inside the sandbox, drives the existing `codex app-server`
session protocol, and gives the worker enough scoped runtime context to complete an fp
issue-to-GitHub-PR loop from inside the sandbox. The orchestrator must never place the Daytona
API key in sandbox files, sandbox env, logs, committed workflow files, or artifacts.

## Current State

### Accepted Decisions

The active system shape is still governed by ADR 0001 and the focused architecture docs:

- `docs/architecture/0001-symphony-deviations.md`
  - D3: exactly one orchestrator is load-bearing.
  - D4: the orchestrator is the sole `fp` writer; workers receive no `fp` credentials. The remote
    issue-to-PR path intentionally supersedes this with scoped REST fp credentials in the
    sandbox.
  - D5: retry is human-gated.
  - D6: source handoff is archive upload. The remote path supersedes this with GitHub clone.
  - D7: artifact return is `git bundle`. The remote path supersedes this with a GitHub PR plus fp
    metadata.
  - D8: the worker is `codex app-server`.
  - D9: worker-side checks are informational. The remote issue-to-PR path makes worker-side
    verification and PR checks part of the worker's completion contract.
- `docs/architecture/orchestrator-runone.md` defines the 20-step pipeline. The remote migration
  changes steps 5, 8, 9, 11, and 13-16. It should preserve the useful state transitions, comment
  cadence, and pre-handoff failure routing, but the code-return boundary becomes a worker-owned
  GitHub PR instead of host-side bundle integration.
- `docs/architecture/daytona-streaming-session.md` documents `DaytonaSession`. Its exit-trap
  workaround is explicitly OSS-observed and must be re-probed against Daytona Cloud before being
  retired.

### Local Daytona Surfaces To Remove Or Replace

Runtime-local surfaces:

- `apps/symphony-orchestrator/daytona/`
- `apps/symphony-orchestrator/package.json` scripts `daytona:up` and `daytona:down`
- `docs/architecture/daytona-local-setup.md`
- README quick-start steps that boot local compose, open the local dashboard, and paste the key
  into tracked `WORKFLOW.md`
- `WORKFLOW.md` wording that says the file targets a local OSS install and contains a concrete
  key field

Test-local surfaces:

- `apps/symphony-orchestrator/test/daytona/compose.test.yaml`
- `apps/symphony-orchestrator/test/daytona/compose.test.macos.yaml`
- `apps/symphony-orchestrator/test/daytona/compose.sh`
- `apps/symphony-orchestrator/test/daytona/dex/`, `otel/`, `pgadmin4/`, `runner-daemon.json`
- `apps/symphony-orchestrator/test/daytona/test-helpers/stack.ts`
- `packages/qa/helpers/setup-daytona-test-stack.md`
- QA scenario text that assumes `localhost:3000` or `localhost:33000`

Keep, but adapt:

- `apps/symphony-orchestrator/src/daytona/daytona.adapter.ts`
- `apps/symphony-orchestrator/src/daytona/daytona.session.ts`
- `apps/symphony-orchestrator/src/daytona/daytona-client.ts`
- `apps/symphony-orchestrator/src/daytona/models.ts`
- `apps/symphony-orchestrator/test/daytona/adapter.test.ts`
- `apps/symphony-orchestrator/test/daytona/session.test.ts`
- `apps/symphony-orchestrator/test/orchestrator/service.integration.test.ts`
- `apps/symphony-orchestrator/snapshot/`
- `packages/qa/`

## Design

### Configuration And Secrets

Use a host-only dotenv file plus environment overrides. Do not store Daytona or GitHub secrets in
`WORKFLOW.md`.

Add:

- `apps/symphony-orchestrator/.env.example`
- `apps/symphony-orchestrator/.gitignore` entry for `.env`
- `docs/architecture/daytona-cloud-sandbox-lifecycle.md`

Environment variables:

| Name | Location | Purpose | Sandbox exposure |
| --- | --- | --- | --- |
| `DAYTONA_API_KEY` | Host `.env` or host shell | Daytona SDK access | Never |
| `DAYTONA_API_URL` | Host `.env` or host shell | Optional SDK override | Never |
| `DAYTONA_TARGET` | Host `.env` or host shell | Cloud region/target | Never |
| `DAYTONA_SNAPSHOT` | Host `.env`, host shell, or workflow default | Snapshot name | Name only |
| `GITHUB_TOKEN` | Host `.env` or host shell | Clone, push, PR creation, PR babysitting | Command env only |
| `FP_REMOTE` | Host `.env`, host shell, or hardcoded remote default | Must be `rest-api` for no-clone fp mode | Command env only |
| `FP_TOKEN` | Host `.env` or host shell | fp REST issue reads/writes | Command env only |
| `FP_SERVER_URL`, `FP_WORKSPACE`, `FP_PROJECT_ID`, `FP_PROJECT_PREFIX` | Host `.env` or host shell | fp no-clone REST project context | Command env only |
| `SWITCHYARD_CODEX_AUTH` | Host `.env` or host shell | Optional host Codex auth path | Copied auth artifact only |

Recommended behavior:

1. `WORKFLOW.md` remains tracked as non-secret operator policy. It may name the sandbox kind,
   snapshot default, repo URL, repo path, source strategy, and artifact strategy, but not an API
   key.
2. The entrypoint loads `apps/symphony-orchestrator/.env` and `process.env`, with `process.env`
   winning.
3. `toDaytonaConfig` gets credentials from host env, not workflow YAML.
4. `WorkflowConfig.sandbox.apiKey` is removed. `apiUrl` and `target` should become optional or
   host-env-owned.
5. `GITHUB_TOKEN` must never be rendered into command text, clone URLs, git remotes, transcript
   logs, fp comments, or downloaded artifacts.
6. Add a `Redactor`/artifact boundary, based on Nocturne's `remote-bootstrap/redaction.ts`,
   `commands.ts`, and `artifacts.ts`.

### Credential Lifetimes

Credential scope must be explicit:

| Credential | Lifetime | Allowed recipients | Must not reach |
| --- | --- | --- | --- |
| `DAYTONA_API_KEY` | Host process only | Daytona SDK client construction | Sandbox env, sandbox files, command text, transcripts, artifacts, fp comments |
| `GITHUB_TOKEN`/`GH_TOKEN` | Worker task session | Host-authored clone setup and worker `git`/`gh` commands through command env | Sandbox create-time env, git remotes, clone URLs, repo files, artifacts |
| `FP_TOKEN` | Worker task session | Worker fp REST commands through command env | Sandbox create-time env, repo files, artifacts, PR text |
| Codex auth file/bundle | Worker session only | `CODEX_HOME` in sandbox for `codex app-server` | Git repo, transcript, PR text, fp comments |

For this migration, `GITHUB_TOKEN` and `FP_TOKEN` may be available to the worker process because
the worker owns branch push, PR creation, fp metadata writes, and PR babysitting. They still must
not be create-time sandbox env vars or durable files. Provide them only as process env to the
specific Daytona session/command that needs them. Use `GIT_ASKPASS` for `git fetch`/`git push`.
For `gh`, prefer `GH_TOKEN`/`GITHUB_TOKEN` process env. Do not run `gh auth login --with-token`
unless `GH_CONFIG_DIR` points at a temporary non-repo directory that is removed before diagnostics
or artifact collection.

Copied Codex auth needs its own lifecycle:

1. Build the smallest practical auth bundle from the host path, ideally only `auth.json` plus any
   Codex files proven necessary by the existing auth probe.
2. Register high-entropy auth-derived values with the redactor before upload.
3. Upload into a non-repo path such as `/workspace/codex-home`.
4. Run `codex app-server` with `CODEX_HOME` pointing at that path.
5. Remove the remote Codex auth path in a `finally` path after the worker turn closes. If cleanup
   fails and the sandbox is kept for forensics, the fp/operator note must say so without printing
   secrets.

### Artifact Redaction And Secret Scanning

Secret hygiene is a boundary requirement, not a logging nicety.

Add a redaction/artifact service with this contract:

- Persisted command stdout/stderr is sanitized before writing local transcripts.
- Command metadata stores env key summaries and secret counts, never env values.
- Rendered command text is rejected if it contains a registered secret value.
- Host-captured diagnostics and downloaded diagnostic artifacts are scanned for exact registered
  secret values before the orchestrator persists or trusts them.
- Worker-authored PR bodies, PR comments, and fp comments are direct sandbox writes, so the host
  cannot preflight them before persistence. The sandbox skill must require writing proposed text
  to temporary files, scanning those files for registered secret values, and only then invoking
  `gh` or `fp`.
- Remote E2E should query the resulting PR text and fp comments after the run and fail if exact
  registered secret values are present. This is a verification backstop, not the primary safety
  boundary.
- The scan starts with `DAYTONA_API_KEY`, `GITHUB_TOKEN`, `FP_TOKEN`, and copied Codex auth
  values, and can register future workflow/env secrets without changing callers.

If an artifact scan fails, route the run to `needs-attention` and keep enough redacted metadata
to debug which artifact failed. Do not post secret-containing text to `fp`.

### Source Handoff

Replace archive upload with GitHub clone.

Workflow config should evolve from:

```yaml
sandbox:
  sourceStrategy: archive
```

to:

```yaml
sandbox:
  sourceStrategy: githubClone
  repoUrl: https://github.com/fiberplane/switchyard.git
  baseBranch: main
```

Implementation shape:

1. Resolve source metadata on the host before claim: `repoUrl`, `baseBranch`, and `baseSha`.
2. Add a source setup script in `sandbox-scripts/` that clones `repoUrl` into `repoPath`, fetches
   `baseSha` if needed, and checks out exactly `baseSha`.
3. If `GITHUB_TOKEN` is present, pass it only as `DaytonaCommandOptions.env` for the clone
   command.
4. Render clone commands with a temporary `GIT_ASKPASS` script, matching Nocturne's approach:
   no token in command text, no token in remote URL, cleanup trap removes the askpass file.
5. After clone, reset `origin` to the credential-free HTTPS URL.
6. Preserve the existing sandbox-local git setup: configure author identity, mark safe
   directory, and ensure the worker can commit.
7. Pass `baseSha`, `baseBranch`, and the deterministic branch name into the worker prompt/env so
   the worker branches from the intended source revision before editing.
8. Record `baseSha`, branch, PR URL, and head commit metadata in fp properties/comments so the
   durable artifact is inspectable without pulling code back to the orchestrator.

The proposal intentionally does not preserve a zip/archive fallback. If GitHub clone is not
available, the run should fail before dispatching a worker.

### Worker-Owned PR Return

Do not download a code artifact back to the orchestrator for host-side integration. The durable
artifact is the GitHub PR created by the worker from inside the sandbox.

Worker responsibilities:

1. Use fp REST from a non-repo workdir, following Nocturne's `fp-sandbox-ticket` skill.
2. Read the issue, comments, dependencies, and relevant docs before editing.
3. Create a deterministic branch from the pinned base.
4. Implement, verify, review, commit, and push.
5. Open a non-draft PR with `gh`.
6. Set fp custom properties for branch/PR/commit metadata.
7. Comment with verification, review passes, PR URL, and any evidence.
8. Babysit PR checks and review feedback until green or a human handoff is required.
9. Mark the issue done only when the workflow's finish criteria are met.

Orchestrator responsibilities:

1. Create and label the sandbox.
2. Clone/bootstrap the repo and fp/GitHub context.
3. Start the worker session with scoped process env.
4. Capture/redact logs for operator diagnostics.
5. Preserve or sweep the sandbox according to the forensic policy.
6. Avoid terminal fp writes once the worker has taken ownership, except for launch/setup failures
   before worker handoff.

`sourceStrategy: githubClone` and `artifactStrategy: pr` should replace the old
`archive`/`bundle` pair for remote Daytona workflows.

### fp Properties For Worker-Owned PRs

The existing `apps/symphony-orchestrator/src/fp/symphony-properties.ts` properties remain useful
for orchestration state, but PR-owned completion needs explicit durable pointers:

| Property | Writer | Purpose |
| --- | --- | --- |
| `symphony_state` | Orchestrator before handoff; worker after handoff | Current schema values: `idle`, `active`, `needs-attention`, `end` |
| `symphony_attempt` | Orchestrator | Current attempt number |
| `symphony_branch` | Worker | Git branch pushed from the sandbox |
| `symphony_pr_url` | Worker | Durable GitHub PR artifact |
| `symphony_pr_number` | Worker | Numeric PR id as a string for filters/reporting |
| `symphony_head_sha` | Worker | Latest pushed commit SHA |
| `symphony_base_sha` | Orchestrator or worker | Pinned source revision the branch started from |
| `symphony_run_id` | Orchestrator | Switchyard run identifier for logs and orchestrator diagnostics |
| `symphony_sandbox_id` | Orchestrator | Daytona sandbox id for Cloud inspection and recovery |
| `symphony_last_error` | Orchestrator or worker | Redacted handoff/blocker summary |

Remove `symphony_artifact`. This repo is still a POC, so there is no useful backward
compatibility burden for a local artifact path once `artifactStrategy: pr` is active.

The worker prompt and sandbox skill must set branch/PR/head metadata as soon as each value exists.
This gives interrupted runs an observable recovery point and lets a future babysitter resume from
fp without asking the orchestrator for hidden state.

Implementation must update `apps/symphony-orchestrator/src/fp/symphony-properties.ts` and the fp
service/docs to decode the new properties. If the fp CLI cannot set these properties through
`FP_REMOTE=rest-api`, add that support before turning on worker-owned PR completion.

There is a known risk that fp extensions/custom-property writes may not behave correctly in
no-clone REST mode. Treat that as an independent spike before relying on worker-side property
mutation. The spike should prove that a sandbox can set and read the canonical `symphony_*`
properties from a non-repo REST workdir. If extension-backed property mutation does not work yet,
the worker can still leave branch/PR metadata in comments for the spike, but productionizing this
workflow should wait for proper REST property support.

### Daytona Cloud Adapter

Keep the existing Effect service boundary. The SDK is already isolated in adapter/session files,
which matches `docs/patterns/boundaries.md`.

Changes:

- Make `DaytonaConfig` Cloud-first:
  - require `apiKey`
  - default `apiUrl` and `target` through the SDK where possible
  - keep `snapshotName`
- Keep `decodeDaytonaConfigEnv` aligned with Cloud defaults: `DAYTONA_API_URL` and
  `DAYTONA_TARGET` are optional, and the snapshot can come from env or a workflow fallback.
- Add resource/profile fields only if the Daytona SDK supports them for our snapshot path. If
  resources are baked into snapshots, document that explicitly in the snapshot README.
- Keep `probeOnInit`, but make the error message Cloud-oriented.
- Use the canonical label schema below so cleanup and orphan sweeping have exact selectors.
- Re-probe `DaytonaSession` on Cloud before changing its exit-trap workaround. The first
  implementation should keep the wrapper until evidence says Cloud reliably provides better
  command-exit semantics.

Canonical labels:

| Label | Production value | Test value | Required |
| --- | --- | --- | --- |
| `app` | `symphony` | `symphony-test` | Yes |
| `source` | `remote-daytona` | `remote-daytona` | Yes |
| `created_at_ms` | Unix epoch millis | Unix epoch millis | Yes |
| `owner` | operator/user label | operator/user label | Yes |
| `fp_issue_id` | internal fp issue id | fixture issue id when present | Production yes |
| `fp_display_id` | display id | fixture display id when present | Production yes |
| `attempt` | orchestrator attempt | attempt when applicable | Production yes |
| `test_run_id` | absent | UUID for test run | Test yes |

### Cloud Cleanup And Orphan Sweeping

Cloud cleanup must be designed as part of the feature, not left to dashboard hygiene.

Runtime cleanup:

- Production orchestrator runs preserve the current forensic policy by default: no proactive
  `deleteSandbox` from `runOne`; `autoStopInterval`/`autoDeleteInterval` and a separate sweeper own
  lifecycle cleanup. Changing this is an explicit review decision below.
- Best-effort download redacted diagnostics before delete when a test/smoke post-create failure
  occurs.
- Tear down known long-running sandbox processes before delete when possible.
- Delete sandboxes in a `finally` path for tests and explicit smoke scripts unless
  `--keep-sandbox`/equivalent is set.
- Poll deletion with a timeout and surface a typed cleanup warning/error if Daytona still lists
  the sandbox.
- If `--keep-sandbox` is set, print only sandbox id, labels, and redacted cleanup notes.

Sweeper contract:

- Delete only sandboxes that have Switchyard-owned labels.
- Require selectors from the canonical schema such as `app=symphony-test`,
  `source=remote-daytona`, `test_run_id=<id>`, or `owner=<user>`.
- Provide dry-run output by default for broad TTL sweeps.
- Refuse to delete unlabeled sandboxes.
- Support a TTL based on `created_at_ms` labels for interrupted test runs.

### Orchestrator Pipeline

Change `runOne` minimally:

| Current step | Current behavior | Remote behavior |
| --- | --- | --- |
| 5 | `integration.prepareSourceHandoff()` creates host archive | Resolve clone source metadata: `repoUrl`, `baseBranch`, and `baseSha` |
| 8 | Upload archive, prompt, Codex auth | Upload prompt and Codex auth only |
| 9 | Untar archive and initialize synthetic repo | Clone GitHub repo, checkout base, configure git, install/verify fp and gh context |
| 11 | Worker writes outcome file; orchestrator later integrates bundle | Worker pushes branch, opens/babysits PR, and updates fp directly |
| 13-16 | Finalize/download/integrate bundle | Removed from remote path |

Failure routing changes after worker handoff: pre-handoff failures are still orchestrator-owned
and route to `needs-attention`; post-handoff failures should be reported by the worker through fp
comments/properties unless the session crashes before the worker can report.

This requires replacing the current archive-shaped `SourceHandoff` with clone metadata, or using
a discriminated union while the migration is in progress. The implementation must remove the
archive tempdir finalizer and the archive upload entry from `runOne`.

### Snapshot

Keep the snapshot concept, but make the docs Cloud-first:

- Add or update a Cloud snapshot template/Dockerfile for Switchyard, modeled on Nocturne's
  Daytona snapshot path.
- Snapshot build uses Daytona Cloud API credentials.
- Snapshot name should probably change from `symphony-codex-bun` to a dated pinned name once we
  verify Cloud resources and image contents, for example `symphony-codex-bun-20260526-v1`.
- Take direct inspiration from Nocturne's Daytona snapshot line: agent-critical tools should be
  baked into the image, not installed on every run.
- The snapshot must contain `git`, `gh`, `fp`, `rg`/`ripgrep`, `bash`, `curl`, `jq`, `procps`,
  `tar`, `unzip`, CA certificates, Bun, drift, ast-grep, and the pinned Codex CLI.
- Install `fp` through the setup.fp.dev channel that supports no-clone REST mode, and record the
  resolved version in snapshot docs.
- `fp --version`, `gh --version`, and `rg --version` should be captured during sandbox
  verification. The `fp` binary must support `FP_REMOTE=rest-api`.
- Add a `verify-sandbox` equivalent that checks tool versions, runs a non-repo
  `FP_REMOTE=rest-api fp issue show <test-issue> --format json` smoke when E2E credentials are
  supplied, and proves `DAYTONA_API_KEY` is absent from sandbox env and common workspace files.
- A bootstrap script may self-heal stale snapshots by installing `gh`, `rg`, or `fp` when missing,
  but the intended Cloud snapshot should have those tools preinstalled so normal runs do not spend
  setup time on package installs.
- If GitHub clone becomes mandatory, `git`, `gh`, and CA certificates are load-bearing.

### Sandbox Skill And Prompt Contract

Add a Switchyard-local sandbox skill modeled on
`~/fiber/nocturne/.agents/skills/fp-sandbox-ticket/SKILL.md`. It should be available inside the
cloned repo and should teach the worker the actual issue-to-PR workflow:

- Use fp from a non-repo REST workdir, with `FP_REMOTE=rest-api`, `FP_TOKEN`,
  `FP_SERVER_URL`, `FP_WORKSPACE`, `FP_PROJECT_ID`, and optional `FP_PROJECT_PREFIX` supplied in
  process env.
- Validate `fp`, `gh`, `git`, and `rg` before editing.
- Read fp issue JSON, comments, dependencies, and referenced docs over REST instead of relying on
  a local `.fp` project checkout.
- Branch from the pinned `baseSha`, implement narrowly, verify, review, commit, push, open a
  non-draft PR with `gh`, and babysit CI/reviews.
- Set `symphony_branch`, `symphony_pr_url`, `symphony_pr_number`, `symphony_head_sha`, and terminal
  state properties as the run progresses.
- Never write `FP_TOKEN`, `GITHUB_TOKEN`, Daytona credentials, or Codex auth into repo files,
  shell profiles, git remotes, PR text, fp comments, or artifacts.

The orchestrator should inject the fp REST env vars into the worker command session and explicitly
tell Codex to run fp commands from the REST workdir, not the repository checkout. This is what
proves the no-clone fp path; the code repository clone is only for code changes.

## End-To-End Verification

There should be three verification levels.

### 1. Unit Tests

Fast tests should cover:

- workflow config rejects secret-bearing `sandbox.apiKey`
- env config requires `DAYTONA_API_KEY`
- clone command rendering never includes `GITHUB_TOKEN`
- clone command uses `GIT_ASKPASS`, resets `origin` to the clean URL, and rejects embedded
  credentials in `repoUrl`
- sandbox setup maps clone failures to `SandboxSetupError` with stage `setup`

### 2. Remote Daytona Integration Tests

Add new gated test suites with separate gates so each signal is narrow.

Adapter/session gate:

- `SWITCHYARD_REMOTE_DAYTONA_TEST=1`
- `DAYTONA_API_KEY`
- `DAYTONA_SNAPSHOT`

Clone gate:

- adapter/session gate variables
- `GITHUB_TOKEN`

Full orchestrator E2E gate:

- clone gate variables
- `SWITCHYARD_REMOTE_DAYTONA_E2E=1`
- explicit remote test fp issue id
- allowed branch prefix
- `FP_REMOTE=rest-api`, `FP_TOKEN`, `FP_SERVER_URL`, `FP_WORKSPACE`, `FP_PROJECT_ID`
- `SWITCHYARD_CODEX_AUTH` or host `~/.codex/auth.json`

Suggested test files:

- `apps/symphony-orchestrator/test/daytona/remote-adapter.test.ts`
- `apps/symphony-orchestrator/test/daytona/remote-session.test.ts`
- `apps/symphony-orchestrator/test/orchestrator/remote-service.integration.test.ts`

The remote adapter/session tests should create sandboxes with unique `test_run_id` labels and
delete them in `afterAll`. They must not boot Docker Compose.

Remote session acceptance:

1. Create a Daytona Cloud sandbox from the configured snapshot.
2. Execute a sync command and assert stdout/stderr/exit code.
3. Upload a small prompt file and download a small result file.
4. Start a `DaytonaSession` command, send stdin, collect stdout, and observe clean stream
   completion.
5. Verify all registered secret values are absent from `printenv`, repo files, command text
   artifacts, downloaded artifacts, and final local artifacts.

### 3. Operator QA Scenario

Replace `packages/qa/scenarios/01-vertical-slice-happy-path.md` with a remote Daytona happy
path, or add a new `02-remote-daytona-happy-path.md` before retiring 01.

Success signal:

1. Host env is loaded from `.env` without printing secrets.
2. Orchestrator creates a remote Daytona sandbox from the configured snapshot.
3. Sandbox verification proves `fp`, `gh`, `rg`, `git`, Bun, Codex, and the fp REST env are usable.
4. Sandbox clones `fiberplane/switchyard` from GitHub using token-isolated clone auth.
5. Codex app-server reads the issue through fp REST from a non-repo workdir, edits a tiny task,
   commits, pushes a deterministic branch, and opens a non-draft PR with `gh`.
6. The worker sets fp branch/PR/head metadata, babysits PR checks/reviews to the configured
   success point, and marks the issue done or blocked with a redacted comment.
7. Cleanup can delete remote test sandboxes by label.
8. Secret scan finds no registered secret values in logs, transcripts, diagnostic artifacts, git
   remotes, PR text, or fp comments.

This is the implementor's clear signal that the migration works.

## Documentation Changes

Add:

- `docs/proposals/active/2026-05-26-remote-daytona-sandboxes.md`
- `docs/architecture/daytona-cloud-sandbox-lifecycle.md`
- `docs/testing/remote-daytona.md`
- `apps/symphony-orchestrator/.env.example`
- `apps/symphony-orchestrator/README.md` if app-local setup instructions need more room than the
  root quick start

Update:

- `README.md` quick start
- `WORKFLOW.example.md`
- `WORKFLOW.md`
- `docs/README.md`
- `docs/architecture/0001-symphony-deviations.md`
- `docs/architecture/orchestrator-runone.md`
- `docs/architecture/daytona-streaming-session.md`
- `apps/symphony-orchestrator/snapshot/README.md`
- `apps/symphony-orchestrator/test/daytona/README.md` or replace it with remote test docs
- `packages/qa/README.md`
- `packages/qa/helpers/*`
- `packages/qa/scenarios/*`

Move to `docs/graveyard/`:

- `docs/architecture/daytona-local-setup.md`

Add a graveyard note for the removed compose implementation that records:

- why local Daytona was removed
- where the old compose files lived
- the macOS `nip.io` DNS workaround
- the local dashboard key/snapshot gotchas
- the runner scheduling repair gotcha
- the historical relationship between production compose and test compose

Delete from active code after the graveyard note exists:

- `apps/symphony-orchestrator/daytona/`
- local compose test files under `apps/symphony-orchestrator/test/daytona/`
- package scripts that boot local Daytona
- QA helpers that instruct local compose setup

## Implementation Phases

### Phase 0: Prove Daytona Cloud Basics

- Receive API key out of band.
- Export `DAYTONA_API_KEY` only in the host shell.
- Run a tiny SDK probe against Cloud:
  - list snapshots
  - create sandbox
  - execute command
  - delete sandbox
- Record feasibility evidence in `docs/experiments/<date>-daytona-cloud-probe.md`; summarize
  only accepted consequences back into this proposal.

### Phase 1: Secret-Safe Config

- Add host `.env.example` and `.gitignore` coverage.
- Remove `sandbox.apiKey` from workflow schema and tracked workflow files.
- Add an explicit pre-decode guard that fails if `sandbox.apiKey` is present; `Schema.Struct`
  strips unknown keys by default, so deletion alone is not a safety check.
- Load host env at the entrypoint.
- Follow the `bb-libs/symphony` secret-ingestion pattern: canonical env fallback, optional `$VAR`
  indirection only where intentional, empty secret env means missing, and validation errors name
  missing keys without printing values.
- Update or delete `decodeDaytonaConfigEnv` and add tests for Cloud defaults.
- Add tests for missing env and no workflow-embedded secrets.

### Phase 2: GitHub Clone Source Strategy

- Add `sourceStrategy: githubClone`, `repoUrl`, and `baseBranch`.
- Resolve and pin `baseSha` before dispatch.
- Replace `SourceHandoff`'s `archivePath` shape with clone metadata, or introduce a temporary
  discriminated union.
- Implement token-isolated clone setup in `SandboxScriptService`.
- Remove archive upload from the remote path.
- Add unit tests for command rendering and secret hygiene.

### Phase 3: Worker fp/GitHub PR Contract

- Add the Switchyard sandbox ticket skill and prompt references modeled on Nocturne.
- Add fp REST env validation and sandbox-side REST workdir setup.
- Add `gh` authentication strategy that does not write tokens to disk unless an explicit temporary
  file is removed before artifact collection.
- Remove `symphony_artifact`.
- Add branch-name generation and fp custom properties for branch, PR, PR number, base SHA, head
  SHA, Switchyard run id, and Daytona sandbox id.
- Replace the current worker prompt contract that mentions `symphony-base`, no fp credentials,
  bundle return, and `outcome.json` with the sandbox skill / PR workflow contract.
- Remove remote-path assumptions that the host finalizes, downloads, or integrates a code artifact.
- Add tests for worker env rendering and redaction.

### Phase 4: fp No-Clone Property Spike

- Prove `FP_REMOTE=rest-api` can read and write the canonical `symphony_*` properties from a
  non-repo REST workdir inside the sandbox.
- Verify whether extension-backed custom properties work without local `.fp` project state.
- Record the result in `docs/experiments/<date>-fp-rest-properties-spike.md`.
- If property writes fail, keep branch/PR metadata comments as temporary evidence only and add or
  upstream the missing fp REST support before enabling worker-owned completion.

### Phase 5: Remote Daytona E2E Tests

- Replace compose-backed test helpers with remote-gated helpers.
- Add remote adapter/session tests.
- Add full orchestrator remote integration test.
- Add label-based cleanup and orphan sweeping for Cloud.

### Phase 6: Retire Local Daytona

- Move local setup doc to `docs/graveyard/`.
- Delete production local compose files and package scripts.
- Delete local compose test stack files.
- Update README, QA scenarios, and docs index.

### Phase 7: Re-evaluate Cloud Session Semantics

- Probe whether Daytona Cloud now populates session exit code or closes the log stream cleanly.
- If yes, simplify `DaytonaSession` and update `daytona-streaming-session.md`.
- If no, keep the exit-trap wrapper and document that the workaround applies to Cloud too.

### Phase 8: Fallow And Dead-Code Cleanup

- Add conservative Fallow configuration and package scripts modeled on Nocturne.
- Run Fallow after the remote path is active and local compose has been removed.
- Remove only clearly identifiable dead code; document or ignore false positives caused by dynamic
  entry points, fixtures, generated files, or public surfaces.
- Commit a concise Fallow baseline summary with counts, command shapes, version, and known modeling
  gaps. Raw Fallow JSON is local evidence, not committed documentation.

### Phase 9: Final Review, Gates, E2E, And PR

- Rerun Fallow and confirm no clearly removable local-Daytona/archive/bundle dead code remains.
- Run a thermonuclear code-quality review subagent loop until it reports no actionable findings.
- Run `bun run test`, `bun run format:check`, `bun run check`, and the remote Daytona E2E
  scenario using `apps/symphony-orchestrator/.env`.
- Scan logs, transcripts, diagnostics, PR text, fp comments/properties, and git remotes for exact
  registered secret values before opening the GitHub PR.
- Push the branch and open a GitHub PR with links to the parent epic, child issues, proposal, E2E
  evidence, health checks, Fallow summary, secret-scan result, and review-loop result.

## Review Questions

None open.
