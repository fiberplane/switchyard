# Symphony Daytona Vertical Slice - v0 Spec

Status: Draft v0 for demo feasibility

Date: 2026-05-04

Purpose: define a minimal Symphony slice for Switchyard using Bun, TypeScript, Effect, `fp`
with custom properties, a local Codex orchestrator, and Codex implementors running inside
Daytona sandboxes.

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

| Component                | Owns                                                                                         | Must not own                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `fp`                     | Durable issue state, parent/child rules, readiness, comments, custom Symphony properties     | Sandbox lifecycle or transient runner state                  |
| Local Codex orchestrator | Dispatch decisions, claims, Daytona lifecycle, artifact integration, final issue transitions | Hidden durable state in chat history                         |
| Daytona                  | Isolated compute, sandbox filesystem, process execution, network/runtime boundary            | Work scheduling or tracker semantics                         |
| Codex worker in Daytona  | Code edits, local checks, result summary, patch/result artifacts                             | Claiming work, deciding global readiness, final ticket state |
| Git                      | Source revision, integration branch, patch application evidence                              | Task readiness or worker lifecycle state                     |

## Reference Findings

The upstream Symphony spec is still the best shape for the coordination model:

- The orchestrator is the single authority for scheduling state.
- Polling reconciles active runs before dispatching new work.
- Worker outcomes are reported back to the orchestrator and turned into explicit transitions.
- The targeted Codex protocol controls protocol details; Symphony controls workspace selection,
  prompt construction, continuation handling, and observability extraction.

The Brettimus TypeScript reference proves the Bun/Effect/fp shape is viable, but its workspace
strategy is intentionally local:

- It uses `fp issue list/show --format json`, validates payloads with Effect Schema, and models
  services with `Context.Tag` and `Layer`.
- It registers `symphony_*` fp properties with an fp extension.
- It uses `git worktree add` because fp can resolve worktrees back to the parent project identity.
- Its dogfooding notes explicitly call out that worktrees do not cross container or remote
  boundaries. Daytona requires a different source handoff strategy.

Daytona changes the execution model:

- Current Daytona TypeScript docs use `@daytona/sdk`.
- The SDK supports `new Daytona({ apiKey, apiUrl, target })`, `daytona.create(...)`, sandbox
  labels/env vars, file APIs, git APIs, and `sandbox.process.executeCommand(...)`.
- Local Daytona OSS runs through Docker Compose from the Daytona repo's `docker` folder.
- On this machine, the compose stack starts without `sudo`; the dashboard returns HTTP 200 and
  `/api/health` returns `{"status":"ok"}`. The `daytona` CLI and `DAYTONA_API_KEY` are not
  currently configured.

Playground evidence:

- Safe playground source lives in the repo at `playgrounds/symphony-daytona-playground/`.
  Generated artifacts and local auth material stay out of the repo.
- Installed `@daytona/sdk@0.171.0`, `effect`, `typescript`, and `@types/bun`.
- Typechecked an Effect service that decodes an fp issue, enforces `symphony_ready=true`, builds a
  Daytona sandbox creation plan, and constructs the Daytona client only when credentials exist.
- `bun run typecheck` passed.
- `bun run demo` produced a sandbox plan and correctly reported the missing `DAYTONA_API_KEY`.

Harder Daytona smoke evidence from 2026-05-04:

- Local API auth was created from the running OSS API container:
  `docker exec daytona-api-1 node dist/apps/api/main.js --create-admin-api-key pjy-smoke-...`.
  The generated key was stored in a local mode-`600` key file outside the repo.
- The intended local Daytona target for this stack is `us`, not `local`. `DAYTONA_API_URL` is
  `http://localhost:3000/api`.
- The compose health checks passed: `/api/health` returned `{"status":"ok"}`, the proxy health
  endpoint returned `{"status":"ok","version":"v0.171.0"}`, and `*.proxy.localhost` resolved
  locally.
- The default snapshot `daytonaio/sandbox:0.5.0-slim` existed but was `pending`; Daytona rejected
  sandbox creation from it with `Snapshot daytonaio/sandbox:0.5.0-slim is pending`.
- Built and activated the intended `symphony-codex-bun` snapshot from
  `node:24-bookworm-slim`, installing `git`, `curl`, `ca-certificates`, `bash`, `jq`, `ripgrep`,
  `procps`, `@openai/codex@0.128.0`, and `bun@1.3.13`.
- Local dev database repairs were required before Daytona would schedule work: the personal
  organization had zero per-sandbox and volume quotas and no `region_quota` row for `us`. The
  runner was also marked unavailable because host disk pressure drove its availability score below
  the compose thresholds. These are local preflight issues, not Symphony behavior.
- The integrated smoke entrypoint is:

  ```bash
  bun run --cwd playgrounds/symphony-daytona-playground smoke
  ```

  The script bundles `src/smoke.ts` for Node and runs the Node bundle because the Daytona SDK
  `uploadFiles` path hung under Bun's runtime detection on this machine.

- The smoke generated local artifact files for the result patch, result JSON, Codex event stream,
  final Codex message, host probes, prompt, repo archive, and manifest. Those artifacts are not
  part of the repo.
- Successful sandbox evidence: created sandbox
  `23cfdaa4-1fc7-4621-ada9-427e22598bd4` from `symphony-codex-bun`, ran the smoke, downloaded
  artifacts, and deleted the sandbox. A post-run API lookup for that sandbox returned `404`.
- The integrated path proved the required worker operations together:
  - uploaded `repo.tgz`, `prompt.md`, and minimal Codex auth into the sandbox with
    `sandbox.fs.uploadFiles`;
  - configured `git user.name`, `git user.email`, and `safe.directory`;
  - ran `git init`, `git add`, `git commit -m "base"`, and `git tag symphony-base`;
  - authenticated Codex inside the sandbox with `CODEX_HOME=/workspace/codex-home` containing only
    a copied `auth.json`; `codex login status` reported `Logged in using ChatGPT`;
  - streamed session logs through `getSessionCommandLogs`, collecting `stream-log-1` through
    `stream-log-3`;
  - started a tiny host HTTP server and proved sandbox-to-host reachability;
  - ran `codex exec --json --dangerously-bypass-approvals-and-sandbox --cd /workspace/repo`
    against the uploaded repo;
  - ran `node test.js` after the Codex edit;
  - generated result patch, result JSON, and diffstat artifacts;
  - downloaded `symphony-result.patch`, `symphony-result.json`, `symphony-result.diffstat`,
    `codex-events.jsonl`, `codex-last-message.txt`, and `host-probes.json` with
    `sandbox.fs.downloadFiles`.
- The Codex edit changed only `message.txt` from `before codex` to
  `hello from daytona codex worker`; `node test.js` passed; `git diff --binary symphony-base`
  produced the expected patch artifact.
- Host reachability result: `host.docker.internal` did not resolve inside the sandbox, and
  `172.17.0.1` did not reach the host server. The host was reachable through routable host
  addresses including `172.19.0.1`, `172.18.0.1`, `100.80.33.10`, and `167.235.24.99` in this
  run. For local demos, the orchestrator should probe candidates and pass the first successful base
  URL to the worker; it should not assume `host.docker.internal`.
- Auth tradeoff: copying only `~/.codex/auth.json` was enough for local ChatGPT-based Codex auth
  inside Daytona. This is acceptable only for throwaway local demos because that file contains
  reusable account auth material.
- OpenAI's Codex auth docs describe distinct ChatGPT subscription auth and API-key auth modes
  (https://developers.openai.com/codex/auth), and the CI/CD auth guide documents file-backed
  ChatGPT auth via `auth.json` under `CODEX_HOME` for trusted private runners
  (https://developers.openai.com/codex/auth/ci-cd-auth).
- Focused auth probe command:

  ```bash
  DAYTONA_API_KEY_FILE=/path/to/local-key \
    bun run --cwd playgrounds/symphony-daytona-playground auth:probe
  ```

  The probe uses disposable `CODEX_HOME` directories inside one Daytona sandbox and writes redacted
  local results under the ignored playground `artifacts/` directory.

- Auth probe findings:
  - copied `auth.json` reported `auth_mode: "chatgpt"` before and after `codex exec`;
  - `codex login status` reported ChatGPT when `OPENAI_API_KEY` and `SANDBOX_OPENAI_API_KEY` were
    unset;
  - `codex exec` succeeded both with `--ignore-user-config` and with user config allowed, so
    `--ignore-user-config` is not the cause of copied-auth failures;
  - setting a placeholder `OPENAI_API_KEY` in the process environment did not override the copied
    ChatGPT auth in this run: status still reported ChatGPT and exec still succeeded;
  - running `codex login --with-api-key` in a disposable mixed `CODEX_HOME` changed `auth_mode` to
    `"apikey"`, removed the ChatGPT token shape, and made status report API-key login. This supports
    the mixed-auth hypothesis: the login flag can overwrite or mask copied subscription auth when
    used in the same home.
- The clean local-demo path is copied ChatGPT `auth.json` with API-key environment variables unset
  unless intentionally testing precedence. The scoped API-key path remains supported by the probe
  through `AUTH_PROBE_OPENAI_API_KEY`, but it was skipped in this run because no real scoped key was
  available.

## v0 Scope

Included:

- One local orchestrator process, started manually by the operator or local Codex session.
- One `fp` project as the source of truth.
- One Daytona local or cloud target.
- One Codex worker per dispatched issue.
- Leaf-issue dispatch only.
- Archive-based source upload and patch-based artifact download.
- Final integration by the orchestrator on the local machine.

Not included:

- A persistent orchestrator database.
- Multi-host scheduling beyond Daytona's target selection.
- A rich dashboard.
- Full review and verification workflow.
- Worker-direct final issue transitions.
- Solving all Codex authentication ergonomics inside the sandbox.

## fp Contract

### Ready Rule

An issue is ready for Symphony dispatch only when all conditions hold:

- `status == "todo"`
- `properties.symphony_ready == "true"`
- `dependencies` is empty or all dependencies are terminal
- the issue has no open child issues
- the issue is not already claimed by `symphony_state`

If an issue has child issues, the parent is treated as an epic and is not dispatched directly.
Children are dispatched independently once ready. The existing fp parent lifecycle extension can
block parent completion while children are open and can auto-complete the parent when all children
finish.

### Custom Properties

The v0 fp extension should register these properties:

| Property                   | Type                         | Writer           | Meaning                                   |
| -------------------------- | ---------------------------- | ---------------- | ----------------------------------------- |
| `symphony_ready`           | select `"true"` or `"false"` | human or planner | Explicit dispatch gate                    |
| `symphony_state`           | select                       | orchestrator     | Durable claim/run/integration state       |
| `symphony_attempt`         | text                         | orchestrator     | Current attempt number                    |
| `symphony_orchestrator_id` | text                         | orchestrator     | Local orchestrator identity for recovery  |
| `symphony_sandbox_id`      | text                         | orchestrator     | Daytona sandbox id or name                |
| `symphony_base_rev`        | text                         | orchestrator     | Git revision archived into the sandbox    |
| `symphony_artifact`        | text                         | orchestrator     | Local artifact path or integration branch |
| `symphony_last_error`      | text                         | orchestrator     | Last normalized failure reason            |

Recommended `symphony_state` values:

- `queued`
- `claimed`
- `sandbox-starting`
- `running`
- `awaiting-artifact`
- `awaiting-integration`
- `integrated`
- `failed`
- `blocked`
- `canceled`

Only the orchestrator writes `symphony_*` runtime properties in v0. The worker can ask for comments
or new issues by writing them into its result JSON. The orchestrator decides whether to apply them.

### Status Transitions

The orchestrator may move an issue from `todo` to `in-progress` when it claims the issue. The
worker must not mark the issue `done`.

The orchestrator marks the issue `done` only after:

- the worker produced a valid result artifact
- the patch applied cleanly to the integration worktree
- the configured local checks passed or were explicitly skipped by operator config
- any worker-requested follow-up issues were filed or deliberately ignored

On worker failure, the orchestrator keeps the issue `in-progress` or moves it back to `todo`
according to retry policy, and writes `symphony_state=failed` plus `symphony_last_error`.

## Workflow Config

The v0 should use a repository-owned workflow document, likely `WORKFLOW.md`, with this shape:

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
  maxAttempts: 2
  maxRetryBackoffMs: 60000

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
  artifactStrategy: patch

codex:
  command: codex exec --json --dangerously-bypass-approvals-and-sandbox --cd /workspace/repo -
  turnTimeoutMs: 3600000

integration:
  branchPrefix: symphony/
  checkCommand: bun run check
```

The `--dangerously-bypass-approvals-and-sandbox` flag is acceptable only because the command runs
inside an externally isolated Daytona sandbox. Outside Daytona, this profile is invalid.

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

The v0 assumes a reusable Daytona snapshot named `symphony-codex-bun` containing:

- `git`
- `bash`
- `bun`
- `codex`
- enough system packages to run the target repo's checks

Codex authentication is the main operational kink. The clean v0 path is to inject the minimum
required runtime secret through Daytona env vars, not to copy the host's whole Codex home directory.

### Source Handoff

Use archive upload for v0.

The orchestrator:

1. Records `baseRev = git rev-parse HEAD`.
2. Creates a clean tarball from tracked source at `baseRev`.
3. Uploads it to the sandbox as `/tmp/repo.tgz`.
4. Uploads the rendered worker prompt as `/tmp/prompt.md`.
5. Runs setup inside the sandbox:

```bash
mkdir -p /workspace/repo
tar -xzf /tmp/repo.tgz -C /workspace/repo
cd /workspace/repo
git init
git add .
git commit -m "base"
git tag symphony-base
```

This avoids local `git worktree` assumptions and avoids giving the worker direct access to the
operator's local filesystem. It also works before GitHub credentials are available in the sandbox.

Future strategies can add `git-clone` and `git-push-branch`, but those require a remote and
credential story.

### Worker Command

The orchestrator runs:

```bash
cd /workspace/repo
codex exec --json --dangerously-bypass-approvals-and-sandbox --cd /workspace/repo - < /tmp/prompt.md
```

For v0, `codex exec --json` is simpler than the app-server protocol and is enough for a vertical
slice. Keep the runner interface event-shaped so `codex app-server` can replace it later without
rewriting scheduling or fp state logic.

### Artifact Collection

At the end of the run, the orchestrator asks the sandbox to create:

```bash
cd /workspace/repo
git diff --binary symphony-base > /tmp/symphony-result.patch
cat > /tmp/symphony-result.json <<'JSON'
{
  "status": "completed",
  "summary": "...",
  "comments": [],
  "newIssues": [],
  "checks": []
}
JSON
```

The actual implementation should have the worker write `symphony-result.json`; the orchestrator
then generates or verifies the patch. The JSON boundary is validated with Effect Schema before
anything is applied locally.

Result schema:

```typescript
const WorkerResult = Schema.Struct({
  status: Schema.Literal("completed", "blocked", "needs-human", "failed"),
  summary: Schema.String,
  comments: Schema.Array(Schema.String),
  newIssues: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      description: Schema.String,
    }),
  ),
  checks: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      exitCode: Schema.Number,
      output: Schema.String,
    }),
  ),
});
```

## Orchestrator Flow

One poll tick:

```text
load workflow
fetch fp candidates
for each ready leaf issue while slots are available:
  claim in fp
  create Daytona sandbox
  upload source archive and prompt
  run Codex worker
  download result JSON and patch
  apply patch in local integration worktree
  run checks
  update fp comments/properties/status
  stop or retain sandbox according to config
```

Detailed state flow:

| Step               | Orchestrator action                          | fp write                                                     |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------ |
| Claim              | Re-read issue, verify ready rule, reserve it | `status=in-progress`, `symphony_state=claimed`               |
| Sandbox create     | `daytona.create(...)` with labels/env vars   | `symphony_state=sandbox-starting`, `symphony_sandbox_id=...` |
| Worker run         | Upload archive/prompt, execute Codex         | `symphony_state=running`                                     |
| Artifact ready     | Download result JSON and patch               | `symphony_state=awaiting-integration`, comment summary       |
| Integration ok     | Apply patch and run checks                   | `symphony_state=integrated`, `status=done`                   |
| Integration failed | Preserve artifact and error                  | `symphony_state=failed`, `symphony_last_error=...`           |

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
      fp.adapter.ts
      models.ts
      service.ts
      errors.ts
    daytona/
      daytona.adapter.ts
      models.ts
      service.ts
      errors.ts
    runner/
      codex-daytona.ts
      models.ts
      service.ts
      errors.ts
    integration/
      git.adapter.ts
      models.ts
      service.ts
      errors.ts
    orchestrator/
      service.ts
      state.ts
      selector.ts
      errors.ts
```

Rules:

- External SDKs and CLIs live in adapter files.
- All parsed `fp`, Daytona, Codex JSONL, and worker result data enters through
  `Schema.decodeUnknown`.
- Errors use `Data.TaggedError` in-process and `Schema.ErrorClass` if serialized.
- `Effect.runPromise` or `Effect.runMain` appears only in the entry point.
- Structured logs always include `issue_id`, `issue_display_id`, `attempt`, and `sandbox_id` when
  available.

## Merge and Dependency Policy

v0 keeps dependency handling deliberately simple:

- Parent issues are not dispatched when they have children.
- A child with dependencies is skipped until dependencies are terminal.
- Independent children may run in parallel only when `agent.maxConcurrentAgents > 1`.
- The orchestrator integrates artifacts serially.
- If a patch does not apply cleanly, the issue is marked `symphony_state=failed` and kept for human
  reconciliation.

This makes the merge story understandable for a demo: workers can run in isolated sandboxes, but
only the orchestrator mutates the local integration branch.

## Worker Prompt Contract

The rendered worker prompt must say:

- You are a Codex implementor running inside a Daytona sandbox.
- The local repo is `/workspace/repo`.
- Do not update final fp ticket state.
- Do not assume durable state outside the repo and `/tmp/symphony-result.json`.
- Make code changes in the repo.
- Run the requested checks when possible.
- Write a concise result JSON with summary, comments, follow-up issues, and check results.

For out-of-scope bugs, the worker writes a `newIssues` entry. The orchestrator files those issues
with `symphony_ready=false` so they do not dispatch accidentally.

## Recovery Rules

The orchestrator must be able to recover from a restart using `fp` plus Daytona labels:

- `symphony_state=claimed|sandbox-starting|running|awaiting-artifact` means inspect
  `symphony_sandbox_id`.
- If the sandbox exists and is still running, either continue collection or cancel it.
- If the sandbox is missing, mark the attempt failed and retry if under `maxAttempts`.
- `symphony_state=awaiting-integration` means the artifact exists locally and should be applied or
  marked failed.
- No state is recovered from Codex chat history.

## Feasibility Decision

This v0 is feasible enough to implement because:

- `fp` already exposes JSON issue reads and custom extension properties.
- The local repo already has fp extensions proving lifecycle hooks for parent/child behavior.
- The Brettimus reference proves the Bun/Effect/Symphony module shape.
- Daytona's TypeScript SDK exposes the sandbox, file, label/env, and process primitives needed for
  archive upload, Codex execution, and artifact download.
- `codex exec` supports stdin prompts, `--json`, `--cd`, and an external-sandbox mode.
- The source/artifact handoff avoids the local worktree limitation that breaks in remote sandboxes.

Open kinks for the next iteration:

- Turn the local Daytona preflight into an explicit setup command: create a real API key, ensure
  `DAYTONA_TARGET=us`, ensure the personal organization has nonzero `us` region quota, and ensure
  runner availability thresholds can schedule work on a disk-constrained dev machine.
- Keep `symphony-codex-bun` creation in setup or CI, and verify it is `active` before dispatching.
- Decide the cleanest Codex auth path inside Daytona. Copied `auth.json` is proven for local demo
  use, but scoped API-key injection remains the safer v0 default and still needs a run with a real
  `OPENAI_API_KEY`.
- Decide whether workers should ever get direct `fp` credentials for comments, or whether all
  tracker writes should remain orchestrator-mediated.
- Decide when to replace `codex exec --json` with `codex app-server`.
