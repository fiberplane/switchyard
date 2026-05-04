# Symphony Daytona Vertical Slice — v1 Spec

Status: Draft v1 (2026-05-04). Brainstorm history under fp epic `SWYRD-ecirajtz`.

## Overview

Switchyard is a Symphony-style coding-agent factory. This document specifies a minimal vertical
slice for a meetup demo: an `fp` issue moves from `todo` to `done` because a Codex worker
running inside a Daytona sandbox produced commits that the orchestrator integrated as a branch
on the host repo.

The pieces:

- **Tracker:** `fp` (durable issue state, custom properties, comments, parent/child rules).
- **Orchestrator:** a single local Bun + TypeScript + Effect process. Polls `fp`, claims work,
  drives Codex sessions, integrates artifacts. The only writer to `fp`.
- **Worker:** `codex app-server` running inside a Daytona sandbox. Reads a prompt, makes commits
  in a fresh repo, writes a small outcome envelope.
- **Workspace:** a Daytona sandbox per dispatched issue. Source enters as a `git archive` tarball;
  artifacts leave as a `git bundle` + an `outcome.json` file.
- **Integration:** the orchestrator fetches the bundle into the host repo as a `symphony/<issue-id>`
  branch. No automatic merge to `main`.

Architectural decisions that diverge from upstream Symphony are recorded in
`docs/architecture/0001-symphony-deviations.md`. Items intentionally deferred from this slice are
collected under fp epic `SWYRD-uouprnfv` and listed in **Future Considerations** at the end of
this spec.

## Demo Thesis

This slice is about the connections between the factory components, not about planning,
review, verification, or factory observability.

The meetup demo should show:

1. A dashboard task exists in `fp`.
2. The local Codex orchestrator understands when that task is ready.
3. The orchestrator claims the task, creates a Daytona sandbox, and runs a Codex worker there.
4. The worker returns a concrete artifact bundle.
5. The orchestrator integrates the artifact and updates `fp`.

The important point is the responsibility split:

| Component                | Owns                                                                                                          | Must not own                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `fp`                     | Durable issue state, parent/child rules, readiness, comments, custom Symphony properties (human-glance only)  | Sandbox lifecycle or transient runner state                                               |
| Local Codex orchestrator | Dispatch decisions, claims (in-memory), Daytona lifecycle, artifact integration, all `fp` writes              | Hidden durable state in chat history; per-turn execution semantics that the protocol owns |
| Daytona                  | Isolated compute, sandbox filesystem, process execution, network/runtime boundary                             | Work scheduling or tracker semantics                                                      |
| Codex worker in Daytona  | Code edits, multiple intermediate commits with descriptive messages, terminal outcome envelope (`outcome.json`)| Claiming work, writing to `fp` directly, deciding final ticket state                      |
| Git                      | Source revision, worker commits, integration branches on host                                                 | Task readiness or worker lifecycle state                                                  |

## Reference Implementations

We borrow shape and protocol details from two reference repos:

- **Upstream Symphony spec** (`references/openai-symphony/SPEC.md`). The coordination model: a
  single authoritative orchestrator polls a tracker, claims work, drives a coding-agent
  subprocess that speaks the targeted Codex `app-server` protocol, and reconciles outcomes back
  into tracker state. We follow this shape closely; deviations are documented in the ADR.
- **Brettimus** (`references/brettimus-symphony/`). A Bun + Effect + `fp` reference that proves
  the module shape (`Context.Tag`, `Layer`, Effect Schema for boundary decoding, `fp` extension
  for property registration). It also has a working `codex app-server` protocol client at
  `src/runner/runner.ts` (~1200 lines) that the Switchyard runner adapts into smaller modules.
  Brettimus uses `git worktree` for source handoff, which does not cross sandbox boundaries —
  Switchyard substitutes archive upload + bundle download.

## Smoke Evidence (2026-05-04)

Operational evidence collected while validating Daytona feasibility for this slice. There are two
runs recorded here, both from playgrounds at `playgrounds/symphony-daytona-playground/`:

1. The original prototype run (`src/smoke.ts`, `bun run smoke`) used `codex exec --json` and
   produced patch-shaped artifacts. Its Daytona-side findings — sandbox lifecycle, archive
   upload, copied `CODEX_HOME` auth, host-reachability behavior, runner-DB repair on this
   machine — are protocol-agnostic and still hold; they are recorded below.
2. The refresh under fp issue `SWYRD-gxgqehxl` (`src/smoke-app-server.ts`,
   `bun run smoke:app-server`) drives the current contract — `codex app-server` over stdio
   plus `git bundle` plus `outcome.json` — and is recorded in
   **App-server smoke (SWYRD-gxgqehxl)** below.

**Daytona local stack:**

- Local Daytona OSS runs through Docker Compose from `references/daytona/docker/`. The compose
  stack starts without `sudo`; the dashboard returns HTTP 200 and `/api/health` returns
  `{"status":"ok"}`.
- Local API auth was created from inside the running API container:
  `docker exec daytona-api-1 node dist/apps/api/main.js --create-admin-api-key pjy-smoke-...`.
  The generated key is stored in a local mode-`600` key file outside the repo.
- The intended local Daytona target is `us` (not `local`); `DAYTONA_API_URL` is
  `http://localhost:3000/api`.
- Local dev database repairs were required before Daytona would schedule work: the personal
  organization needed nonzero per-sandbox and volume quotas plus a `region_quota` row for `us`,
  and the runner had to be marked available (its score had been driven below threshold by host
  disk pressure). These are local preflight issues, not Symphony behavior.

**Sandbox image:**

- The default `daytonaio/sandbox:0.5.0-slim` snapshot was `pending` and rejected creation. We
  built and activated `symphony-codex-bun` from `node:24-bookworm-slim` with `git`, `curl`,
  `ca-certificates`, `bash`, `jq`, `ripgrep`, `procps`, `@openai/codex@0.128.0`, and
  `bun@1.3.13`.

**End-to-end smoke (lifecycle, upload, auth, exec, download):**

- Created sandbox `23cfdaa4-1fc7-4621-ada9-427e22598bd4` from `symphony-codex-bun`, ran the
  smoke, downloaded artifacts, and deleted the sandbox cleanly.
- Uploaded `repo.tgz`, `prompt.md`, and Codex auth into the sandbox via
  `sandbox.fs.uploadFiles`.
- Configured `git user.name`, `git user.email`, `safe.directory`; ran `git init / add /
  commit -m "base" / tag symphony-base` to seed the repo (the source-handoff flow described in
  the **Source Handoff** section).
- Authenticated Codex inside the sandbox with `CODEX_HOME=/workspace/codex-home` containing only
  a copied `auth.json`; `codex login status` reported `Logged in using ChatGPT`.
- Ran a Codex coding command against the uploaded repo and verified that the worker successfully
  edited a file (`message.txt`) and that a post-edit `node test.js` passed inside the sandbox.

> The end-to-end run above used `codex exec --json` rather than `codex app-server`, and produced
> patch-shaped artifacts. The re-run against the current design is recorded in **App-server
> smoke (SWYRD-gxgqehxl)** below; the auth, upload, and lifecycle bullets above are
> protocol-agnostic and were re-confirmed by that run.

**Host reachability:**

- `host.docker.internal` does **not** resolve inside the sandbox, and `172.17.0.1` does not
  reach the host. The host was reachable on this run through routable host addresses including
  `172.19.0.1`, `172.18.0.1`, `100.80.33.10`, and `167.235.24.99`.
- This finding is no longer load-bearing for the worker: under the current design the worker
  does not contact the host (artifacts move via sandbox-side files that the orchestrator
  collects), but it remains relevant for any future feature that needs sandbox-to-host network
  paths.

**Codex auth (local demo path):**

- Copying only `~/.codex/auth.json` into the sandbox under `CODEX_HOME` is enough for
  ChatGPT-based Codex auth. This is acceptable only for throwaway local demos because the file
  contains reusable account auth material.
- Auth probe findings (collected via
  `bun run --cwd playgrounds/symphony-daytona-playground auth:probe` with disposable
  `CODEX_HOME` directories):
  - copied `auth.json` reports `auth_mode: "chatgpt"` before and after a Codex run;
  - `codex login status` reports ChatGPT when `OPENAI_API_KEY` and `SANDBOX_OPENAI_API_KEY` are
    unset;
  - a placeholder `OPENAI_API_KEY` in the process environment did **not** override the copied
    ChatGPT auth on this run;
  - running `codex login --with-api-key` in a disposable mixed `CODEX_HOME` changed `auth_mode`
    to `"apikey"`, supporting the mixed-auth hypothesis: the login flag can mask copied
    subscription auth when used in the same home.
- The clean local-demo path is copied ChatGPT `auth.json` with API-key environment variables
  unset. The scoped API-key path remains supported by the probe through
  `AUTH_PROBE_OPENAI_API_KEY` but was skipped in this run for lack of a real scoped key.
- OpenAI's Codex auth docs distinguish ChatGPT subscription auth and API-key auth modes
  (https://developers.openai.com/codex/auth); the CI/CD auth guide documents file-backed
  ChatGPT auth via `auth.json` under `CODEX_HOME` for trusted private runners
  (https://developers.openai.com/codex/auth/ci-cd-auth).

### App-server smoke (SWYRD-gxgqehxl)

Re-run of the Daytona end-to-end against the current contract: `codex app-server` over stdio,
`git bundle` artifact transport, `outcome.json` decoded with the `WorkerOutcome` Effect Schema.
Entrypoint:

```bash
DAYTONA_API_KEY_FILE=/path/to/local-key \
  bun run --cwd playgrounds/symphony-daytona-playground smoke:app-server
```

The host script (`src/smoke-app-server.ts`) uploads an in-sandbox driver
(`src/codex-driver.cjs`) that spawns `codex app-server` with stdin/stdout piped, drives the
JSON-RPC handshake, and writes `transcript.jsonl` plus the worker's `outcome.json` under
`/tmp/.symphony/`.

**Run result:** sandbox `b2f4815b-…` from `symphony-codex-bun`, deleted after the run. The full
flow `initialize → thread/start → turn/start → turn/completed` traversed Daytona's stdio bridge
in ~22 s. The transcript captured 134 protocol messages (104 `item/agentMessage/delta`,
10 `item/started`/10 `item/completed`, 5 `turn/diff/updated`, 5 `thread/tokenUsage/updated`,
1 `item/fileChange/outputDelta`, 6 `account/rateLimits/updated`, plus lifecycle events). No
approval requests fired with `approvalPolicy: "never"` and `sandbox: "danger-full-access"`. The
worker did not contact the host network; no host base URL was injected.

**Worker behaviour:** Codex edited `message.txt`, ran `git add -A && git commit`, and wrote
`/tmp/.symphony/outcome.json` with the contract-shaped envelope. Decoding with
`Schema.decodeUnknown(WorkerOutcome)` succeeded:

```json
{"status":"completed","summary":"Rewrote message.txt and committed the smoke test change."}
```

**Bundle integration:** the orchestrator step ran
`git bundle create /tmp/.symphony/work.bundle symphony-base..HEAD` (476 bytes, the
production-shaped delta against `symphony-base`) and a self-contained
`git bundle create /tmp/.symphony/work-full.bundle --all` (942 bytes). The smoke fetched the
`--all` bundle into a freshly initialized host repo and produced
`symphony/gx-<timestamp>` with the worker's commit on top of the seeded base, validating the
sandbox-to-host transfer described in **Sandbox-to-Host Code Transfer**. The delta bundle was
also exercised: it correctly refused to fetch into a host repo that did not yet hold
`symphony-base`, with `error: Repository lacks these prerequisite commits`. This is the
expected production behavior — the orchestrator must seed the same base into the integration
worktree before applying the delta — and is why the smoke produces both shapes for evidence.

**Protocol shape verified against `codex-cli 0.128.0`** (matches the field guidance in **Worker
Protocol** above; recorded here as evidence rather than as protocol documentation):

- `initialize` params: `{ clientInfo, capabilities }`. No `initialized` notification needed by
  this server build (the brettimus reference runner sends one; harmless but unnecessary here).
- `thread/start` params: `{ cwd, approvalPolicy: "never", sandbox: "danger-full-access",
  ephemeral: true }`. `approvalPolicy: "auto"` (used by the brettimus reference) is rejected by
  this build with `unknown variant 'auto'` — valid `AskForApproval` strings are
  `untrusted | on-failure | on-request | never` plus a granular object form.
- `turn/start` params: `{ threadId, cwd, approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" }, input: [{ type: "text", text: prompt }] }`.
  `sandbox` (thread scope) and `sandboxPolicy` (turn scope) are different field shapes and case
  conventions; treat them as distinct types.
- Turn termination: `turn/completed` notification carrying `params.turn.{id, status, …}`. There
  is no separate `turn/failed` notification — failures arrive as JSON-RPC error responses on the
  original `turn/start` id.
- Server-initiated approval-style requests are dispatched as `applyPatchApproval`,
  `execCommandApproval`, `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval` (plus
  `item/tool/requestUserInput` and `item/tool/call` for the user-input/tool channels). The
  driver responds with `{ decision: "approved" }` as defense-in-depth even with
  `approvalPolicy: "never"`; `item/tool/requestUserInput` is treated as a hard turn failure per
  openai-symphony SPEC §10.5.

**Operational notes:** the local Daytona admin API key from the prior smoke at
`/tmp/daytona-api-key-pjy` (mode 600) was still valid and was reused. `codex app-server` stderr
emits one `bubblewrap not on PATH` ERROR on startup and falls back to its vendored bubblewrap;
the message is benign on this snapshot.

Run artifacts (gitignored) live under
`playgrounds/symphony-daytona-playground/artifacts/app-server-<timestamp>/`:
`transcript.jsonl`, `outcome.json`, `work.bundle`, `work-full.bundle`,
`codex.stderr.log`, `driver-final.json`, `host-bundle-log.txt`, `manifest.json`.

## Scope

**Operational assumption (load-bearing):** exactly one orchestrator may run at a time. Running
two orchestrators concurrently is undefined behavior — there is no defensive guard against
double-dispatch. The operator is responsible for not starting a second orchestrator process.
See ADR D3.

Included:

- One local orchestrator process, started manually by the operator or local Codex session.
- One `fp` project as the source of truth.
- One Daytona local or cloud target.
- One Codex worker per dispatched issue, invoked through the `codex app-server` protocol.
- Leaf-issue dispatch only.
- Archive-based source upload (single-commit `symphony-base`) and **git-bundle**-based artifact download.
- Final integration by the orchestrator on the local machine, materialized as a `symphony/<issue-id>` branch on the host repo. **No automatic merge to `main`.**

Not included:

- A persistent orchestrator database.
- Multi-host scheduling beyond Daytona's target selection.
- A rich dashboard.
- Full review and verification workflow.
- Worker-direct final issue transitions or any `fp` writes from inside the sandbox.
- Automatic retries — every worker failure hands back to a human (see **Retry & Eligibility**).
- Continuation turns (cheap to add later under `app-server`; deferred — see Future Considerations).
- Orchestrator-side check verification against the integrated branch (deferred).
- Worker-driven follow-up issue filing (deferred).
- Solving all Codex authentication ergonomics inside the sandbox.

## fp Contract

### Ready Rule

An issue is ready for Symphony dispatch only when all conditions hold:

- `status == "todo"`
- `properties.symphony_ready == "true"`
- `dependencies` is empty or all dependencies are terminal
- the issue has no open child issues
- the issue is not in the orchestrator's in-memory claim set

If an issue has child issues, the parent is treated as an epic and is not dispatched directly.
Children are dispatched independently once ready. The existing fp parent lifecycle extension can
block parent completion while children are open and can auto-complete the parent when all children
finish.

The eligibility check **does not consult `symphony_state`**. fp's built-in `status` is the durable
claim signal; `symphony_state` is a human-glance mirror only (see below).

### Custom Properties

The fp extension at `.fp/extensions/symphony-state.ts` registers these properties:

| Property              | Type                                                          | Writer           | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `symphony_ready`      | select `"true"` / `"false"`                                   | human or planner | Explicit dispatch gate                                                   |
| `symphony_state`      | select `"idle"` / `"active"` / `"end"` / `"needs-attention"`  | orchestrator     | Coarse human-glance runtime hint. **Not authoritative; not read for correctness.** |
| `symphony_attempt`    | text (numeric)                                                | orchestrator     | Current attempt number                                                   |
| `symphony_artifact`   | text                                                          | orchestrator     | Integration branch name (e.g. `symphony/SWYRD-abc123`) and/or local artifact path |
| `symphony_last_error` | text                                                          | orchestrator     | Last normalized failure reason                                           |

`symphony_state` is a **purely informational mirror** of orchestrator-internal state. It exists so
a human glancing at an issue in fp can immediately see "is anything happening with this?" The
orchestrator's authoritative claim/run state lives in process memory, not in fp. The eligibility
filter, the dispatch decision, and the retry policy do not consult `symphony_state` — they operate
on built-in `status` and the orchestrator's in-memory `running` set.

Valid `symphony_state` transitions:

- `idle → active` (orchestrator claims an issue; written together with `status=in-progress`)
- `active → end` (worker reported `completed` AND integration succeeded; written together with `status=done`)
- `active → needs-attention` (worker failure, malformed outcome, bundle/integration failure, or worker-reported `blocked` / `needs-human` / `failed`)
- `needs-attention → active` (re-dispatch after human re-arms via `status=in-progress` → `todo`)

There is no auto-retry path: every move out of `needs-attention` requires a human to flip the
issue's `status` back to `todo`.

Eligibility decision table (`symphony_state` column is informational only; eligibility derives from
`status` + `symphony_ready` + the orchestrator's in-memory claim set):

| `status`      | `symphony_ready` | `symphony_state`   | Deps + children                                  | Meaning                                       | Eligible? |
| ------------- | ---------------- | ------------------ | ------------------------------------------------ | --------------------------------------------- | --------- |
| `todo`        | `false`          | any                | any                                              | Not gated for Symphony                        | No        |
| `todo`        | `true`           | `idle`             | any non-terminal dep, OR any open child          | Blocked by upstream work                      | No        |
| `todo`        | `true`           | `idle`             | all deps terminal AND no open children           | Fresh candidate                               | Yes       |
| `todo`        | `true`           | `needs-attention`  | all deps terminal AND no open children           | Human re-armed after a previous failure       | Yes       |
| `todo`        | `true`           | `needs-attention`  | any non-terminal dep, OR any open child          | Re-armed but blocked again                    | No        |
| `in-progress` | any              | `active`           | any                                              | Currently being worked on (in claim set)      | No        |
| `in-progress` | any              | `needs-attention`  | any                                              | Parked for human triage                       | No        |
| `done`        | any              | `end`              | any                                              | Terminal                                      | No        |

**Concurrency** is calculated against the orchestrator's in-memory set of issues with a live
worker turn. `idle`, `end`, and `needs-attention` issues do not contribute to concurrency. Sandbox
lifecycle (live, paused, deleted) is governed by `sandbox.autoStopInterval` /
`sandbox.autoDeleteInterval` and tracked separately from the worker concurrency cap.

### Writer Boundary

Only the orchestrator writes `symphony_*` runtime properties. The worker has no `fp` credentials
inside the sandbox and cannot write to `fp` directly. Worker-side intent (summary, observations,
follow-up requests) reaches `fp` only by way of artifacts the orchestrator collects and translates
into `fp` writes after the run.

This is a deliberate divergence from upstream Symphony, where the worker writes to the tracker via
client-side tools or external CLIs. See `docs/architecture/0001-symphony-deviations.md` for the
rationale; see fp issue `SWYRD-jjlifoqq` for the open question of whether to relax this.

### Status Transitions

The orchestrator moves an issue from `todo` to `in-progress` when it claims the issue. The worker
never writes `status`.

The orchestrator marks the issue `done` only after:

- the protocol stream emitted a clean turn-completion event;
- the worker produced a valid `outcome.json` decoding to `status: "completed"`;
- the git bundle from the sandbox was fetched and a `symphony/<issue-id>` branch was created on the
  host repo from `symphony-base`.

On any failure (worker abnormal exit, malformed `outcome.json`, bundle-fetch failure, branch
creation failure, or worker-reported non-`completed` outcome), the orchestrator keeps the issue at
`status=in-progress`, writes `symphony_state=needs-attention`, writes `symphony_last_error=<normalized reason>`,
and posts an fp comment with the failure narrative. **The orchestrator does not auto-retry.**

### Retry & Eligibility

Retry is **human-gated**: every worker/integration failure parks the issue at `needs-attention`
for human triage. The human re-arms by flipping `status` from `in-progress` back to `todo`. The
orchestrator picks the issue up via the normal eligibility rule. `symphony_attempt` increments
on each (re-)dispatch.

`agent.maxAttempts` exists in workflow config but defaults to `1`; the field is reserved for
future auto-retry policy and is currently unused. There is no `agent.maxRetryBackoffMs` field —
no auto-retry means no backoff timer.

Continuation turns (re-poll tracker after a clean turn exit, possibly start another turn on the
same live thread; upstream Symphony spec §7.1 / §10.3) are deferred. They become essentially free
under `codex app-server` and are tracked as fp issue `SWYRD-clnybkgo`.

## Workflow Config

The orchestrator reads a repository-owned workflow document, likely `WORKFLOW.md`, with this shape:

```yaml
tracker:
  kind: fp
  dispatchFilter:
    property: symphony_ready
    value: "true"

polling:
  intervalMs: 10000

agent:
  maxConcurrentAgents: 1
  maxAttempts: 1   # no auto-retry; reserved for future policy

sandbox:
  kind: daytona
  apiUrl: "$DAYTONA_API_URL"
  apiKey: "$DAYTONA_API_KEY"
  target: "$DAYTONA_TARGET"
  snapshot: symphony-codex-bun
  language: typescript
  autoStopInterval: 15
  autoDeleteInterval: -1
  repoPath: /workspace/repo
  sourceStrategy: archive
  artifactStrategy: bundle

codex:
  command: codex app-server
  turnTimeoutMs: 3600000

integration:
  branchPrefix: symphony/
  # No automatic check command. Worker may run checks inside the sandbox; orchestrator treats
  # those results as informational. Orchestrator-side verification is deferred — see fp issue
  # SWYRD-ovvmzqxw.
```

`codex app-server` is a long-running stdio process; the orchestrator speaks the targeted
app-server protocol over the process's stdio. The protocol process inherits Codex auth from
`CODEX_HOME` inside the sandbox (see Daytona setup). No `--dangerously-bypass-approvals-and-sandbox`
flag is required at the CLI level — sandbox/approval posture is configured through the protocol's
`approvalPolicy` (sent on `thread/start` and `turn/start`) and the per-scope sandbox fields:
`thread/start.sandbox` is an `AskForApproval`-paired `SandboxMode` string (kebab-case, valid
variants: `read-only | workspace-write | danger-full-access`), and
`turn/start.sandboxPolicy` is a `SandboxPolicy` object (camelCase variants: `{ type: "readOnly" }`,
`{ type: "workspaceWrite" }`, `{ type: "dangerFullAccess" }`, `{ type: "externalSandbox" }`). The
two field shapes and case conventions are different by design — treat them as distinct types,
not interchangeable. The "external sandbox" assumption (we don't need codex's own sandboxing
because Daytona provides isolation) is expressed via those protocol fields, not via a CLI flag.

For Switchyard's posture inside Daytona, the orchestrator MUST send `approvalPolicy: "never"`
plus `sandbox: "danger-full-access"` on `thread/start` and `sandboxPolicy: { type:
"dangerFullAccess" }` on `turn/start`. Asking for approvals from inside a disposable sandbox
would stall the run with no operator to answer; the sandbox itself is the trust boundary. Do not
use `approvalPolicy: "auto"` — the targeted `codex-cli 0.128.0` rejects it as `unknown variant
'auto'` (valid `AskForApproval` string variants are `untrusted | on-failure | on-request | never`,
plus a granular object form).

## Daytona Execution Strategy

### Local Daytona Setup

For the demo, run Daytona OSS locally:

```bash
cd references/daytona
docker compose -f docker/docker-compose.yaml up -d
```

The local dashboard is expected at `http://localhost:3000` with development credentials
`dev@daytona.io` / `password`. Before running the orchestrator, create or configure an API key and
export:

```bash
export DAYTONA_API_URL=http://localhost:3000/api
export DAYTONA_TARGET=local
export DAYTONA_API_KEY=...
```

The target value may need to be adjusted to whatever the local Daytona runner exposes.

### Sandbox Image or Snapshot

The orchestrator assumes a reusable Daytona snapshot named `symphony-codex-bun` containing:

- `git`
- `bash`
- `bun`
- `codex`
- enough system packages to run the target repo's checks

Codex authentication is the main operational kink. The clean path is to inject the minimum
required runtime secret through Daytona env vars, not to copy the host's whole Codex home directory.

### Source Handoff

The orchestrator uses archive upload:

1. Records `baseRev = git rev-parse HEAD`.
2. Creates a clean tarball from tracked source at `baseRev`.
3. Uploads it to the sandbox as `/tmp/repo.tgz`.
4. Uploads the rendered worker prompt as `/tmp/prompt.md`.
5. Runs setup inside the sandbox:

```bash
mkdir -p /workspace/repo /tmp/.symphony
tar -xzf /tmp/repo.tgz -C /workspace/repo
cd /workspace/repo
git init
git add .
git commit -m "base"
git tag symphony-base
```

`/tmp/.symphony/` is the worker's required output directory. The orchestrator creates it as part
of sandbox setup so the worker never has to. Required artifact files written there: `outcome.json`
(by the worker) and `work.bundle` (by the orchestrator after the worker turn ends, via a follow-up
`sandbox.process.executeCommand` call).

This avoids local `git worktree` assumptions and avoids giving the worker direct access to the
operator's local filesystem. It also works before GitHub credentials are available in the sandbox.

Future strategies can add `git-clone` and `git-push-branch`, but those require a remote and
credential story.

### Worker Protocol

The orchestrator runs `codex app-server` inside the Daytona sandbox as a long-lived stdio process.
The orchestrator speaks the targeted Codex app-server protocol over that stdio stream.

Concretely, inside the sandbox:

```bash
cd /workspace/repo
exec codex app-server
```

The orchestrator drives the protocol:

1. **Initialize** the app-server session per the targeted protocol version.
2. **Create or resume a thread** with `cwd = /workspace/repo`.
3. **Start the first turn** with the rendered worker prompt (see **Worker Prompt Contract**).
4. **Stream protocol events** to the orchestrator. Persist every event to
   `.symphony/runs/<issue-id>/<attempt>/transcript.jsonl` on the host as it arrives. The protocol
   stream **is** the conversation transcript — no separate logging needed.
5. **Watch for the turn-completion event.** On `turn_completed`, the orchestrator transitions to
   artifact collection. On `turn_failed`, `turn_cancelled`, `turn_ended_with_error`, or
   `turn_input_required`, the orchestrator records the failure reason and proceeds to the
   `needs-attention` path.
6. **Stop the app-server process** after artifact collection.

The orchestrator runs one turn per dispatched issue. Continuation turns (re-poll tracker after
`turn_completed`, possibly start another turn on the same live thread) are deferred — see fp
issue `SWYRD-clnybkgo`.

Generated TypeScript bindings for the protocol come from
`codex app-server generate-ts --out src/runner/protocol/` and live behind a `bun run codegen`
task. The Switchyard runner adapts the Brettimus reference at
`references/brettimus-symphony/src/runner/runner.ts` into cleanly decomposed modules (transport,
protocol-events, session lifecycle, turn streaming) so the protocol surface stays inspectable.

### Artifact Collection

After a clean turn-completion event, the orchestrator collects artifacts via Daytona's file/process
APIs.

Inside the sandbox (the orchestrator runs these via `sandbox.process.executeCommand` after the
worker turn ends):

```bash
cd /workspace/repo
# Empty-commit-range case: if the worker made no commits, symphony-base..HEAD is empty.
# git bundle would refuse with "Refusing to create empty bundle" — bundle from the tag instead
# so we always have a valid file to download. The orchestrator detects "no worker commits" by
# inspecting the bundle on the host (no refs beyond symphony-base = no work).
if [ -n "$(git log symphony-base..HEAD --oneline 2>/dev/null)" ]; then
  git bundle create /tmp/.symphony/work.bundle symphony-base..HEAD
else
  git bundle create /tmp/.symphony/work.bundle symphony-base
fi
# outcome.json is written by the worker during the turn (see Worker Prompt Contract)
ls /tmp/.symphony/outcome.json
```

The orchestrator downloads:

| Artifact          | Producer                          | Required for `completed`? |
| ----------------- | --------------------------------- | ------------------------- |
| `transcript.jsonl`| Orchestrator (live, while streaming) | Always present (may be partial on crash) |
| `work.bundle`     | Sandbox (`git bundle create symphony-base..HEAD`) | Yes |
| `outcome.json`    | Worker (during the turn, before `turn_completed`) | Yes |

The worker outcome envelope is the only side-channel artifact the worker is required to write. Its
schema:

```typescript
const WorkerOutcome = Schema.Struct({
  status: Schema.Literal("completed", "blocked", "needs-human", "failed"),
  summary: Schema.String, // may be markdown; arbitrary length
});
```

Validation: `Schema.decodeUnknown(WorkerOutcome)` on the downloaded file. Decode failure or missing
file → orchestrator marks `symphony_state=needs-attention`,
`symphony_last_error="malformed worker outcome"`, and proceeds to the integration path with
whatever the bundle contained (creating a `symphony/<issue-id>-incomplete` branch for forensics).

After artifact download, the orchestrator writes its own record:

```typescript
const OrchestratorRecord = Schema.Struct({
  status: Schema.Literal("integrated", "needs-attention"),
  branch: Schema.String,                   // e.g. "symphony/SWYRD-abc123"
  baseRev: Schema.String,                  // host SHA at dispatch time
  workerStatus: Schema.OptionFromNullOr(   // null if outcome.json was missing/malformed
    Schema.Literal("completed", "blocked", "needs-human", "failed"),
  ),
  integrationError: Schema.optional(Schema.String),
  startedAt: Schema.String,                // ISO timestamp
  endedAt: Schema.String,                  // ISO timestamp
  attempt: Schema.Number,
});
```

Stored at `.symphony/runs/<issue-id>/<attempt>/outcome-record.json`. This file is the orchestrator's
durable record of what happened, separate from the worker's `outcome.json`.

Local layout after a run:

```
.symphony/runs/<issue-id>/<attempt>/
  transcript.jsonl       # protocol stream, orchestrator-written as events arrive
  work.bundle            # git history from sandbox
  outcome.json           # worker-written; may be missing on abnormal exit
  outcome-record.json    # orchestrator-written final record
```

### Sandbox-to-Host Code Transfer

Worker commits cross the sandbox boundary as a `git bundle`:

1. Sandbox runs `git bundle create /tmp/.symphony/work.bundle symphony-base..HEAD`.
2. Orchestrator downloads `work.bundle` to `.symphony/runs/<issue-id>/<attempt>/`.
3. On the host repo:
   ```bash
   git fetch <bundle-path> +HEAD:refs/symphony/<issue-id>
   git branch symphony/<issue-id> refs/symphony/<issue-id>
   ```
4. The branch is the integration deliverable. **No automatic merge to `main`.** Human reviewers
   read `git log symphony/<issue-id>` to see the worker's commits and messages.

The bundle preserves full commit history (including each commit message), which is part of the
worker's thought process and a primary artifact for human review. If the bundle download or
fetch fails, the orchestrator parks at `needs-attention` with
`symphony_last_error="bundle integration failed: <reason>"` and preserves the bundle file
locally for forensic investigation.

The source-handoff strategy is configurable for future iterations that need full git history in
the sandbox (e.g., exploratory tasks) — see fp issue `SWYRD-yailwgkj`.

## Orchestrator Flow

One poll tick:

```text
load workflow config
reconcile in-memory running set against tracker (if any tracker state is terminal, drop from running)
fetch fp candidates (status=todo + symphony_ready=true, deps terminal, no open children, not in claim set)
for each ready leaf issue while concurrency slots are available:
  claim in-memory and write fp transition
  create Daytona sandbox (labelled with fp_issue_id)
  upload source archive and prompt
  spawn `codex app-server` over Daytona's process API
  initialize protocol session, create thread, start turn
  stream protocol events to transcript.jsonl as they arrive
  await turn-completion event
  download work.bundle and outcome.json
  decode outcome.json with Effect Schema
  fetch bundle into host repo as branch symphony/<issue-id>
  write outcome-record.json
  post fp comment with summary; transition fp state
  stop or retain sandbox according to config
```

Detailed state flow (only orchestrator-driven `fp` writes; protocol-event observability lives in
`transcript.jsonl`, not in `fp`):

| Step                  | Orchestrator action                                                 | fp write                                                                                |
| --------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Claim                 | Re-read issue, verify ready rule, add to in-memory running set      | `status=in-progress`, `symphony_state=active`, `symphony_attempt=<n>`                   |
| Sandbox + worker run  | `daytona.create(...)`, spawn `codex app-server`, drive protocol     | comment "Dispatched to sandbox `<sandbox-id>`"; no `fp` property changes                |
| Turn completed        | Receive `turn_completed`; download bundle + `outcome.json`          | comment "Worker turn completed; integrating"; no property changes yet                  |
| Integration ok        | Decode `outcome.json` (status=`completed`); fetch bundle into branch | `status=done`, `symphony_state=end`, `symphony_artifact=symphony/<issue-id>`           |
| Worker non-`completed`| Decode `outcome.json` (status≠`completed`); still create branch     | `symphony_state=needs-attention`, `symphony_last_error=<status>: <summary head>`       |
| Bundle/decode failure | Preserve whatever artifacts exist locally                           | `symphony_state=needs-attention`, `symphony_last_error=<reason>`                       |
| Protocol failure      | Persist partial transcript, attempt salvage bundle, drop from running | `symphony_state=needs-attention`, `symphony_last_error=protocol stream <reason>`     |

## Effect Implementation Shape

Recommended first app:

```text
apps/symphony-orchestrator/
  package.json
  src/
    index.ts
    workflow/
      models.ts
      loader.ts
      errors.ts
    fp/
      fp.adapter.ts          # wraps `fp` CLI / SDK calls
      models.ts              # Schema definitions for fp issue payloads
      service.ts
      errors.ts
    daytona/
      daytona.adapter.ts     # wraps @daytona/sdk
      models.ts
      service.ts
      errors.ts
    runner/                  # codex app-server protocol client; decompose, do not single-file it
      protocol/              # generated bindings (codex app-server generate-ts)
      transport.ts           # stdio framing, send/recv
      events.ts              # event Schema + emission
      session.ts             # initialize, create thread, lifecycle
      turn.ts                # one-turn streaming loop
      service.ts             # AgentRunner Effect service surface
      errors.ts
    integration/
      git.adapter.ts         # wraps host git operations
      bundle.ts              # bundle download + fetch + branch creation
      models.ts
      service.ts
      errors.ts
    artifact/
      models.ts              # WorkerOutcome, OrchestratorRecord schemas
      store.ts               # `.symphony/runs/<issue>/<attempt>/` layout
      errors.ts
    orchestrator/
      service.ts
      state.ts               # in-memory running set, claim management
      selector.ts
      errors.ts
```

Rules:

- External SDKs and CLIs live in adapter files (`*.adapter.ts`).
- All parsed `fp`, Daytona, app-server protocol, and worker outcome data enters through
  `Schema.decodeUnknown`.
- Errors use `Data.TaggedError` in-process and `Schema.ErrorClass` if serialized.
- `Effect.runPromise` or `Effect.runMain` appears only in the entry point.
- Structured logs always include `issue_id`, `issue_display_id`, `attempt`, and `sandbox_id` when
  available.
- The runner module is deliberately decomposed across multiple files (transport / events /
  session / turn). Brettimus's reference implementation packs this into one ~1200-line file; for
  Switchyard, keep each concern in its own file so the protocol surface stays inspectable.

## Merge and Dependency Policy

Dependency handling is deliberately simple:

- Parent issues are not dispatched when they have children.
- A child with dependencies is skipped until dependencies are terminal.
- Independent children may run in parallel only when `agent.maxConcurrentAgents > 1`.
- The orchestrator creates integration branches serially on the host repo. Each successful run
  produces one `symphony/<issue-id>` branch starting from `symphony-base` (the host SHA captured
  at dispatch).
- The orchestrator never merges to `main`. Branches are left for human review.
- If bundle fetch or branch creation fails, the issue is marked `symphony_state=needs-attention`
  and the bundle file is preserved at `.symphony/runs/<issue-id>/<attempt>/work.bundle` for
  forensic inspection.

The host repo accumulates `symphony/*` branches; humans (or future automation) decide what to
merge.

## Worker Prompt Contract

The rendered worker prompt must say:

- You are a Codex worker running inside a Daytona sandbox.
- The local repo is `/workspace/repo`. The starting commit is tagged `symphony-base`.
- You have **no `fp` credentials**. Do not attempt `fp` writes; the orchestrator owns all `fp`
  state.
- Make code changes in the repo. Commit early, commit often, with descriptive commit messages —
  the orchestrator will preserve your full commit history via `git bundle`, and the human reviewer
  reads commit messages to understand your reasoning. Prefer multiple small commits over one
  squash.
- You may run any commands you need to validate your work (build, test, type-check). The output
  of those commands does **not** need to be persisted; the orchestrator does not validate or
  re-run them.
- The directory `/tmp/.symphony/` is pre-created for you by the orchestrator before your turn
  starts. Write your outcome envelope there.
- You do **not** need to contact the host machine. Outcome flows entirely through files in the
  sandbox; the orchestrator collects them after your turn ends. No host base URL is provided.
- **Before producing your final assistant message / exiting the turn**, you MUST write
  `/tmp/.symphony/outcome.json` with this exact shape:
  ```json
  {
    "status": "completed" | "blocked" | "needs-human" | "failed",
    "summary": "<markdown narrative — what you did, why, and any caveats>"
  }
  ```
- Use `status: "completed"` only if you believe the work is fully done and ready for a human to
  review the resulting branch. Use `"blocked"` if a precondition you cannot satisfy stops you;
  `"needs-human"` if the work is partially done but you are uncertain; `"failed"` if you tried
  and could not produce useful output.
- The `summary` becomes the fp comment narrative. Include any out-of-scope observations or
  follow-up suggestions there as prose. **Do not file follow-up issues yourself.** Worker-driven
  follow-up filing is deferred — see fp issue `SWYRD-oxevvenq`.

## Recovery Rules

The orchestrator's authoritative claim/run state lives in process memory and is **lost on
restart**. Recovery uses `fp` + Daytona labels rather than `symphony_state` mirroring:

1. **Tracker scan.** Query `fp` for issues with `status=in-progress AND symphony_ready=true`. These
   are issues that the orchestrator was working on (or had handed back to a human for re-arming).
2. **Sandbox scan.** Query Daytona for sandboxes labelled with `fp_issue_id`. Sandbox labels are
   the load-bearing identity for recovery (which is why `symphony_sandbox_id` is not part of the
   `fp` property contract — see ADR D4b).
3. **Reconcile per issue:**
   - Sandbox exists + reachable + worker process alive → either continue collecting (re-attach to
     `codex app-server` over the sandbox's stdio if possible; otherwise cancel and mark
     `needs-attention`).
   - Sandbox exists but worker process is gone → attempt salvage bundle from sandbox; mark
     `needs-attention`.
   - Sandbox is missing or unreachable → mark `needs-attention` with
     `symphony_last_error="sandbox lost during orchestrator restart"`. Do not auto-retry.
   - Issue is `in-progress` with no live sandbox AND no local `outcome-record.json` → mark
     `needs-attention`. Human re-arms by transitioning to `todo`.
4. No state is recovered from the Codex protocol stream beyond what was already persisted to
   `transcript.jsonl`. Recovery does not replay protocol events.
5. **Base revision recovery.** The orchestrator captures `baseRev` (host SHA at dispatch) into
   the local `outcome-record.json` while a run is in flight. If a sandbox is recovered but the
   matching `outcome-record.json` is missing or malformed, the orchestrator cannot reconstruct
   `baseRev` deterministically and MUST mark the issue `needs-attention` rather than guessing.
   This avoids integrating a worker bundle against a host SHA different from the one the worker
   was given.

## Feasibility

This is feasible to implement because:

- `fp` already exposes JSON issue reads and custom extension properties; the existing parent
  lifecycle extension proves the hook surface.
- The Brettimus reference proves the Bun + Effect + `fp` module shape **and** has a working
  `codex app-server` protocol client at `references/brettimus-symphony/src/runner/runner.ts`.
  The Switchyard runner adapts it into smaller modules.
- Daytona's TypeScript SDK exposes the sandbox, file, label/env, and process primitives needed
  for archive upload, app-server invocation, and artifact download. The smoke evidence above
  proves the sandbox lifecycle, file upload, Codex auth via `CODEX_HOME`, and host-reachability
  paths end-to-end.
- `git bundle` round-trips cleanly across the sandbox-to-host boundary, preserving worker
  commits and messages.

Open setup work before implementation begins:

- Turn the local Daytona preflight into an explicit setup command: create a real API key, ensure
  `DAYTONA_TARGET=us`, ensure the personal organization has nonzero `us` region quota, and
  ensure runner availability thresholds can schedule work on a disk-constrained dev machine.
- Keep `symphony-codex-bun` snapshot creation in setup or CI, and verify it is `active` before
  dispatching.
- Decide the cleanest Codex auth path inside Daytona. Copied `auth.json` is proven for local
  demo use; scoped API-key injection remains the safer default and still needs a run with a
  real `OPENAI_API_KEY`.
- Re-run the smoke against `codex app-server` + `git bundle` + `outcome.json` —
  **done under `SWYRD-gxgqehxl`**; results recorded under **App-server smoke (SWYRD-gxgqehxl)**
  in **Smoke Evidence (2026-05-04)**.
- Generate TypeScript bindings (`codex app-server generate-ts`) and wire them into a
  `bun run codegen` script before runner module work begins.

## Alternatives Considered

A summary of the design choices that have a real "we could have done it differently" alternative,
with the reasoning that pointed us at the chosen path. The ADR captures the divergences from
upstream Symphony in more depth; this section is about the choices internal to Switchyard.

### `symphony_state` as a thin mirror, not the authoritative state machine

We could have put a rich state machine into `fp` (something like `queued / claimed /
sandbox-starting / running / awaiting-artifact / awaiting-integration / integrated / failed /
blocked / canceled`). It would have made the demo visually rich — chips changing color in the
tracker as the orchestrator works.

We didn't, because durable state in the tracker turns into a recovery hazard the moment an
orchestrator crashes mid-run. Stale `fp` state has to be reconciled against in-memory state on
every restart, and the reconciliation logic is more code and more bugs than the demo benefit
buys.

The chosen path: a 4-value `symphony_state` (`idle / active / end / needs-attention`) that
serves only as a human-glance hint. The orchestrator's authoritative claim/run state lives
in-memory; eligibility, dispatch, and retry decisions never read `symphony_state`. Tracker
narrative comes from `fp` comments instead of property transitions.

### `codex app-server` over `codex exec --json`

A first cut of this spec used `codex exec --json` because it's a one-shot CLI invocation —
spawn, read JSONL from stdout, parse. Simple to integrate, simple to reason about.

We changed our minds because upstream Symphony is genuinely structured around `codex
app-server` as the canonical worker protocol (default `codex.command: codex app-server`,
session/thread/turn identity model, schema-enforced events, continuation-turn semantics). Going
with `exec` made us a less-faithful Symphony implementation in exchange for unclear simplicity
gains. The Brettimus reference also has a working ~1200-line app-server client, so the cost
isn't designing-from-scratch — it's adapting.

The chosen path: `codex app-server` over stdio. The protocol stream **is** the conversation
transcript (no separate logging needed), `turn_completed` events are schema-enforced (no
JSONL-drift fragility), and continuation turns become a small future extension rather than a
protocol rewrite.

### `git bundle` over patches, `format-patch` series, `git push`, or tarballs

Worker output has to cross the sandbox-to-host boundary somehow. Each option has tradeoffs:

- A single `git diff --binary > result.patch` is the simplest single-file artifact, but it
  flattens commit history — the worker's commit-by-commit reasoning is lost.
- `git format-patch` preserves history but produces a directory of files instead of one.
- `git push` from the sandbox to the host needs credentials in the sandbox we don't have.
- A tarball of the working tree drops history entirely.

The chosen path: `git bundle create work.bundle symphony-base..HEAD`. One file, full commit
history, clean `git fetch` on the host. The worker's commits and commit messages are the most
important artifact for human review; the bundle preserves them losslessly.

### Orchestrator as the sole `fp` writer, no `fp` credentials in the sandbox

Upstream Symphony allows the worker to write to the tracker directly — move the issue to
`Done`, post comments, file follow-ups. We could have followed suit (it would simplify several
things, including new-issue filing, which we ended up deferring as a result).

We didn't, because giving the sandboxed worker `fp` credentials enlarges the auth blast radius
in a way that's hard to bound. Adding scoped tokens, deciding which transitions the worker can
make, handling races between worker and orchestrator writes — all of that is more surface area
than this slice can afford.

The chosen path: the orchestrator is the only `fp` writer. The worker communicates outcome via
a small Effect-decoded JSON file (`outcome.json`) that the orchestrator reads after the turn
ends. This costs us one schema and an invented "outcome convention," and removes a whole class
of auth and concurrency questions. Whether to relax this later is `SWYRD-jjlifoqq`.

### Outcome envelope as a side-channel file, not a structured block in the final assistant message

Once we picked `codex app-server`, we briefly considered putting the outcome envelope in the
final assistant message (markdown code fence with JSON, parsed on `turn_completed`). Upstream
Symphony defines transport-level events (`turn_completed`, `turn_failed`, etc.) but does not
specify a worker-level "task done with outcome X" signal — so anything we do here is our
invention, regardless of channel.

The chosen path: a side-channel `outcome.json` file. Effect Schema decode at the boundary fits
the codebase idiom; it's symmetric with future side-channel artifacts (e.g., the deferred
follow-up reporting format); and the protocol events still fire normally to carry transport
outcome separately. Two cleanly separated signals: protocol events say "the turn ended, here's
why," the file says "the task ended, here's what I think happened."

### Human-gated retry, no auto-retry

Upstream Symphony has a full retry model — exponential backoff, stall detection, continuation
retries. We could have implemented a subset for the demo.

We didn't, because there's no time on stage to *demonstrate* retry, and auto-retrying broken
code wastes Daytona resources for no demo payoff. Human-gated handoff is the right default
until we know which failures are flaky-transient vs. genuinely-broken.

The chosen path: every failure parks at `needs-attention` and waits for a human to re-arm the
issue (flip `status` from `in-progress` back to `todo`). The `agent.maxAttempts` knob is
preserved at `1` so the future auto-retry policy has a place to live without re-shaping config.

### Branch on host, not an integration worktree

Brettimus uses `git worktree` for per-issue workspaces because `fp` can resolve worktrees back
to the parent project identity. That model breaks across the sandbox boundary (worktrees don't
cross containers), so it can't be the source-handoff mechanism here.

We considered keeping the worktree concept *only* on the host side as the integration target —
the orchestrator would `git worktree add` for each issue and apply the worker's output there.

The chosen path: branch-on-host with no worktrees. The orchestrator fetches each worker bundle
into a `symphony/<issue-id>` branch starting from `symphony-base`. The host repo accumulates
review-ready branches that humans (or future automation) can merge or discard. No worktree
directories proliferate, no cleanup logic, and the model maps cleanly onto how teams already
work with branches.

### Archive upload (single-commit), not volume mounts or full clones

The sandbox needs source. We could mount a host worktree as a Daytona volume, clone from
GitHub inside the sandbox, or sync the host repo (including `.git`) via a richer upload step.

The chosen path: `git archive HEAD` into a tarball, upload, extract, and create a fresh
single-commit repo tagged `symphony-base`. No GitHub credentials in the sandbox, no
volume-mount complexity, and the payload is small. The cost is an honest one — the worker
can't `git log` past `symphony-base`, which limits exploratory tasks. That cost is acceptable
for the narrow patch-style work the demo targets, and the source-handoff strategy is a
configurable knob (`sandbox.sourceStrategy`) so future iterations can switch without
re-shaping the rest of the system. Tracked as `SWYRD-yailwgkj`.

### Orchestrator does not re-run checks against the integrated branch

A natural addition would be: after the orchestrator creates `symphony/<issue-id>`, run
`bun run check` against it on the host, and only post `completed` if checks pass.

We didn't include this, because we'll be using Switchyard to develop Switchyard. The project's
own CI on the integration branch (push-time, PR-time) already enforces health, so re-running
checks orchestrator-side would be redundant work the project's CI already does. For projects
without that property, this becomes a real gap — tracked as `SWYRD-ovvmzqxw`.

## Future Considerations

Items intentionally out of scope for this slice. Each is tracked as a child of fp epic
`SWYRD-uouprnfv`. They are listed here so a reader can see the scope boundary without consulting
fp.

- **Worker follow-up reporting format and orchestrator filing behavior** (`SWYRD-oxevvenq`).
  The worker writes only `outcome.json` (status + summary) and does not file new fp issues.
  Future versions need to decide whether the worker writes a structured side-channel artifact
  (e.g., `new-issues.jsonl`) or a free-form report the orchestrator parses, plus the
  orchestrator's duplicate-suppression policy on retry.

- **Continuation-turn behavior under `codex app-server`** (`SWYRD-clnybkgo`). Upstream Symphony
  defines continuation: after a clean `turn_completed`, the orchestrator can re-poll the tracker
  and start another turn on the same live thread (up to `agent.max_turns`). The current design
  does one turn per dispatch. With `app-server` already in place, adding continuation is a small
  spec extension.

- **Full git history transfer to sandbox** (`SWYRD-yailwgkj`). Archive upload seeds the sandbox
  with a single-commit history; the worker cannot `git log` past `symphony-base`. Exploratory
  tasks that benefit from real history are limited. Possible solutions: mount a host worktree
  as a Daytona volume, clone from GitHub inside the sandbox (requires credential injection), or
  sync the host repo including `.git` via a richer upload step.

- **Orchestrator-side check verification** (`SWYRD-ovvmzqxw`). The orchestrator does not run
  any health checks against the integrated branch on the host. Worker-side checks are
  informational only. We use Switchyard to develop Switchyard, so the project's own CI on the
  integration branch enforces health post-merge for the demo's purposes. A configurable
  orchestrator-side health probe is a future addition.

- **Worker-direct `fp` writes** (`SWYRD-jjlifoqq`). The worker is forbidden from writing to
  `fp`, which deviates from upstream Symphony. The cost is one Effect-decoded outcome file; the
  benefit is a clean security/auth boundary and a single source of truth for `fp` writes. Open
  question for future iterations: relax this with scoped credentials? Constrain to comments
  only?

See `docs/architecture/0001-symphony-deviations.md` for the architectural rationale behind
several of these deferrals.

(The end-to-end smoke re-run against the current artifact format ran under `SWYRD-gxgqehxl`
and is recorded in **App-server smoke (SWYRD-gxgqehxl)** under **Smoke Evidence (2026-05-04)**.)
