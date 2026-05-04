# Symphony Dashboard Brief

Status: Draft for product/design exploration.
Visual direction: 1950s American switchyard — enamel signage, signal lamps, switch
stands, Solari split-flap boards. Utilitarian, period equipment that happens to be
beautiful. The railroad world is the *interface vocabulary*, not decoration.

## Synopsis

Switchyard is a local Symphony-style coding-agent factory. An operator marks an `fp` issue as
ready, a single local Bun/Effect orchestrator claims the issue, creates a Daytona sandbox, runs a
Codex worker through `codex app-server`, collects a worker outcome plus a `git bundle`, integrates
the bundle into a host branch, and writes the result back to `fp`.

The dashboard should make that factory legible. It is not the source of truth and should not
replace `fp`, Daytona, Git, or the artifact store. It should be the operator's control room:
what is running, what needs attention, what completed recently, where the branch/artifacts live,
and which external object to open when a human needs to act.

The current vertical slice intentionally deferred a rich dashboard. This brief describes a basic
web dashboard that can sit on top of the data the slice already captures or has explicitly
planned to capture.

## Core Story

The key demo path:

1. An `fp` issue has `status=todo` and `symphony_ready=true`.
2. The orchestrator claims it, writes `status=in-progress`, and sets `symphony_state=active`.
3. The orchestrator creates a Daytona sandbox labelled with the `fp` issue identity.
4. Codex runs in that sandbox, streams protocol events, commits changes, and writes
   `/tmp/.symphony/outcome.json`.
5. The orchestrator downloads `transcript.jsonl`, `outcome.json`, and `work.bundle`.
6. The orchestrator creates a host branch like `symphony/SWYRD-abc123`.
7. The orchestrator writes `.symphony/runs/<issue-id>/<attempt>/outcome-record.json`, posts an
   `fp` comment, and sets either `symphony_state=end` or `symphony_state=needs-attention`.

Design should emphasize the handoff chain: `fp issue -> orchestrator run -> Daytona sandbox ->
Codex turn -> artifact bundle -> host branch -> human review`.

## Primary Users

- **Operator during a demo:** needs instant confidence that the system is alive and advancing.
- **Engineer reviewing a completed run:** needs branch, commits, transcript, outcome summary, and
  issue context.
- **Engineer triaging failures:** needs last error, failed phase, sandbox state, saved artifacts,
  and the re-arm path.
- **Designer/product reviewer:** needs historical texture: what the system did over time, not just
  a terminal log.

## Data We Can Visualize

### From `fp`

The durable task truth:

| Field                            | Meaning                                      | Dashboard use             |
| -------------------------------- | -------------------------------------------- | ------------------------- |
| `id`                             | Stable issue id                              | Link key and join key     |
| `displayId` / identifier         | Human issue key such as `SWYRD-gxgqehxl`     | Primary label in lists    |
| `title`                          | Issue title                                  | Row title, detail header  |
| `description`                    | Full task text                               | Detail drawer/tab         |
| `status`                         | `todo`, `in-progress`, `done`                | Durable workflow column   |
| `priority`                       | `critical`, `high`, `medium`, `low`, or null | Sorting and urgency       |
| `parent` / children              | Epic/subissue relationship                   | Blocked/epic display      |
| `dependencies`                   | Required predecessor issues                  | Readiness blockers        |
| `comments`                       | Milestones and worker summary                | Run narrative timeline    |
| `revisions`                      | Commits attached with `fp issue assign`      | Review/traceability       |
| `properties.symphony_ready`      | Explicit dispatch gate                       | Ready queue filter        |
| `properties.symphony_state`      | `idle`, `active`, `end`, `needs-attention`   | Human-glance runtime chip |
| `properties.symphony_attempt`    | Current attempt number                       | Attempt badge/history     |
| `properties.symphony_artifact`   | Branch/path text                             | Branch/artifact link      |
| `properties.symphony_last_error` | Last normalized failure reason               | Triage lead               |

Important nuance: `symphony_state` is deliberately informational. Eligibility uses `status`,
`symphony_ready`, dependency/child state, and the orchestrator's in-memory running set.

### From Orchestrator Runtime

The live in-memory state that should feed the current dashboard:

| Field                        | Meaning                                                 | Dashboard use                      |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------- |
| `pollIntervalMs` / next poll | Poll cadence and next check                             | "Next refresh" status              |
| `maxConcurrentAgents`        | Configured concurrency cap                              | Slot meter                         |
| running issue set            | Current live worker turns                               | Active sessions list               |
| claim set                    | Issues reserved/running                                 | Duplicate dispatch guard indicator |
| retry/attention set          | Failed or deferred work                                 | Needs-attention queue              |
| Codex session id             | `<thread_id>-<turn_id>`                                 | Copyable protocol identifier       |
| last Codex event/message     | Latest protocol activity                                | Live pulse and detail row          |
| token totals                 | Input/output/total tokens                               | Cost/throughput display            |
| latest rate-limit payload    | Upstream Codex limit state                              | Health/rate-limit strip            |
| structured logs              | `issue_id`, `issue_display_id`, `attempt`, `sandbox_id` | Search/filter pivots               |

Switchyard v0 has no auto-retry, so the classic upstream "retry queue" should become a
`needs attention` or `human re-arm` queue in the product language. The UI may still keep a
technical "retry" label for future compatibility, but it should not imply automatic retry in v0.

### From Artifact Store

Historical run truth should come from `.symphony/runs/<issue-id>/<attempt>/`.

| File                  | Producer                                  | Dashboard use                      |
| --------------------- | ----------------------------------------- | ---------------------------------- |
| `transcript.jsonl`    | Orchestrator while protocol events stream | Full event log and activity replay |
| `outcome.json`        | Worker                                    | Worker status and summary          |
| `work.bundle`         | Sandbox command after worker turn         | Download/debug artifact            |
| `outcome-record.json` | Orchestrator                              | Durable run record                 |

Current record schema:

```json
{
  "status": "integrated",
  "branch": "symphony/SWYRD-abc",
  "baseRev": "abc123",
  "workerStatus": "completed",
  "startedAt": "2026-05-04T20:00:00.000Z",
  "endedAt": "2026-05-04T20:01:00.000Z",
  "attempt": 1
}
```

For failures, `status` becomes `needs-attention`, `workerStatus` can be `blocked`,
`needs-human`, `failed`, or null, and `integrationError` may be present.

### From Codex App-Server Transcript

`transcript.jsonl` is the primary rich stream. Each line captures direction, timestamp, and the
JSON-RPC message.

Useful event families:

| Event                                               | Dashboard use                                                |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `initialize`, `thread/start`, `turn/start`          | Protocol setup timeline                                      |
| `thread/started`, `turn/started`, `turn/completed`  | Session/turn lifecycle                                       |
| `item/agentMessage/delta`                           | Live assistant prose stream                                  |
| `item/started`, `item/completed`                    | Tool/item lifecycle                                          |
| `turn/diff/updated`                                 | Change activity indicator                                    |
| `thread/tokenUsage/updated`                         | Live token totals                                            |
| `account/rateLimits/updated`                        | Rate-limit strip                                             |
| `item/commandExecution/requestApproval` and similar | Should be rare; triage as policy violations                  |
| `item/tool/requestUserInput`                        | Hard failure in v0 because no operator is inside the sandbox |

Token accounting should prefer absolute totals from `thread/tokenUsage/updated.tokenUsage.total`
and avoid double-counting delta-style fields.

### From Daytona

Daytona is the workspace and compute truth:

| Field                                          | Meaning                                                    | Dashboard use                   |
| ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| `id` / `name`                                  | Sandbox identity                                           | Copyable sandbox link/id        |
| `labels`                                       | Join to `fp` issue, e.g. `fp_issue_id` or issue display id | Recovery and dashboard joins    |
| `snapshot`                                     | Snapshot name such as `symphony-codex-bun`                 | Environment/version badge       |
| `target`                                       | Region/runner target, e.g. `us`                            | Infra placement                 |
| `state`                                        | `creating`, `started`, `stopped`, `error`, etc.            | Sandbox health chip             |
| `desiredState`                                 | Desired lifecycle state                                    | Drift indicator                 |
| `errorReason` / `recoverable`                  | Failure reason                                             | Triage details                  |
| `cpu`, `memory`, `disk`, `gpu`                 | Allocated resources                                        | Resource context                |
| `autoStopInterval` / `autoDeleteInterval`      | Lifecycle policy                                           | Cleanup expectations            |
| `createdAt`, `updatedAt`, `lastActivityAt`     | Lifecycle timestamps                                       | Age and idle time               |
| `runnerId`, `daemonVersion`, `toolboxProxyUrl` | Operational details                                        | Debug drawer                    |
| usage/metrics telemetry                        | CPU/RAM/disk seconds, price, time series if enabled        | Historical cost/resource charts |

Daytona sandbox states to design for include: `creating`, `restoring`, `started`, `stopped`,
`starting`, `stopping`, `destroying`, `destroyed`, `error`, `build_failed`, `pending_build`,
`building_snapshot`, `pulling_snapshot`, `archiving`, `archived`, `resizing`, `snapshotting`, and
`forking`.

### From Git

The branch is the human review artifact:

| Field          | Meaning                               | Dashboard use                 |
| -------------- | ------------------------------------- | ----------------------------- |
| `baseRev`      | Host SHA captured at dispatch         | Compare base                  |
| `branch`       | `symphony/<issue-id>`                 | Primary completed-run CTA     |
| worker commits | Commit history from bundle            | Review narrative              |
| changed files  | From branch diff or bundle inspection | Impact summary                |
| bundle path    | Local artifact path                   | Forensic download/open action |

There is no automatic merge to `main`. The dashboard should frame a completed run as "ready for
human review", not "merged".

## Proposed Information Architecture

### 1. Overview

The first screen should be dense and operational:

- **Health strip:** Orchestrator online/offline, last snapshot time, next poll, config loaded,
  Daytona reachable, `fp` reachable, active snapshot name.
- **Counters:** Ready queue, active runs, needs attention, integrated today, total attempts,
  active sandboxes, stopped/error sandboxes.
- **Capacity:** `running / maxConcurrentAgents`, with a simple slot meter.
- **Cost/activity:** total runtime, input/output/total tokens, current tokens/sec if available,
  latest rate-limit snapshot.
- **Queues:** ready to dispatch, active sessions, needs attention.
- **Recent completions:** last N integrated branches with status, duration, worker status, and
  review link.

### 2. Active Runs

A table optimized for scanning:

| Column        | Content                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| Issue         | `SWYRD-...`, title, priority, parent/child marker                            |
| Durable state | `fp.status`, `symphony_state`, readiness                                     |
| Run phase     | claimed, sandbox starting, streaming turn, collecting artifacts, integrating |
| Sandbox       | id/name, Daytona state, snapshot, target                                     |
| Runtime       | started at, elapsed, attempt                                                 |
| Codex         | session id, turn id, last event, last message                                |
| Tokens        | input/output/total, context window if available                              |
| Actions       | open `fp`, open sandbox, open transcript, open artifact dir                  |

For active rows, the strongest visual cue should be "what is happening now": setup, running,
collecting, integrating, or stuck. The raw `symphony_state=active` chip is too coarse by itself.

### 3. Needs Attention

This is the v0 failure center.

Show issues parked at `status=in-progress` plus `symphony_state=needs-attention`, and any local
run records with `status=needs-attention`.

Critical fields:

- Issue and title.
- Attempt count.
- Failure class: protocol failure, malformed outcome, worker non-completed, bundle failure,
  sandbox lost, integration failure.
- `symphony_last_error`.
- Worker `summary` when available.
- Branch if a forensic branch was created.
- Artifact directory and transcript link.
- Daytona sandbox state and recoverability.
- Re-arm instruction: human changes `fp.status` back to `todo` after triage.

### 4. Run History

Historical runs should be grouped by issue, then attempt.

Each run card/row:

- Attempt number.
- Final orchestrator status: `integrated` or `needs-attention`.
- Worker status: `completed`, `blocked`, `needs-human`, `failed`, or missing/malformed.
- Duration from `startedAt` to `endedAt`.
- Branch and base revision.
- Sandbox id/name if captured.
- Token totals and event counts if transcript was parsed.
- Outcome summary.
- Key events: dispatch, turn started, first diff, turn completed, bundle created, branch created,
  fp updated.

Useful charts:

- Runs per day by final status.
- Median and p95 run duration.
- Token usage over time by issue or run.
- Failure reason distribution.
- Attempts per completed issue.
- Sandbox lifecycle duration: create time, active time, idle time.

### 5. Issue Detail

The detail view is the hub for one issue:

- Header: issue id, title, status, priority, `symphony_ready`, `symphony_state`.
- Links: `fp` web permalink, desktop deep link, branch, local artifact path, Daytona sandbox.
- Readiness panel: dependencies, open children, ready gate, current in-memory claim if present.
- Current run panel if active.
- Attempts timeline.
- Transcript viewer with filters by event family.
- Outcome and orchestrator record JSON.
- Comments timeline from `fp`, including worker summary comments.
- Git review panel: base rev, branch, commits, changed files.

### 6. Infrastructure

This page can stay simple for v0 but gives the designer a surface for demo confidence:

- Daytona API URL and target.
- Snapshot `symphony-codex-bun` status.
- Active sandboxes labelled for Symphony.
- Sandbox states grouped by `started`, `stopped`, `error`, build states, and cleanup states.
- Runner/preflight warnings from smoke evidence: quota, runner availability, snapshot pending,
  local dashboard health.
- Codex auth mode status if safely probeable, without exposing secrets.

## Deep Links And Permalinks

Use links as first-class UI objects. A dashboard row should never leave the operator wondering
where to inspect the source of truth.

### `fp` Issue Links

This local project is linked to:

- Workspace: `fiberplane`
- Remote project id: `R9zpu11vgX01RHwthhNy5`
- Server: `https://app.fp.dev`

Observed web permalink pattern from local fp project references:

```text
https://app.fp.dev/w/<workspaceSlug>/projects/<remoteProjectId>/issues/<issueId>
```

Example:

```text
https://app.fp.dev/w/fiberplane/projects/R9zpu11vgX01RHwthhNy5/issues/gxgqehxlbpccbbqpturpntbsrhmxegsh
```

Potential desktop deep link if the handler is enabled:

```text
fp://issue?workspace=fiberplane&project=R9zpu11vgX01RHwthhNy5&id=<issueId>
```

The dashboard should display the friendly issue key (`SWYRD-gxgqehxl`) but link using the stable
full issue id.

### Daytona Links

For local Daytona:

- Dashboard: `http://localhost:3000`
- API: `http://localhost:3000/api`
- Health: `http://localhost:3000/api/health`

If the Daytona UI supports sandbox-detail URLs in the target deployment, add a direct sandbox
link from sandbox id/name. Until that is confirmed, expose the id, name, target, state, and a copy
button.

### Git Links

In v0, integration is local branch creation, not necessarily a hosted PR:

- Local branch name: `symphony/<issue-id>` or `symphony/<display-id>`.
- Local artifact path: `.symphony/runs/<issue-id>/<attempt>/work.bundle`.
- If a remote is later pushed, add GitHub branch/compare/PR links:
  - branch: `<repo>/tree/symphony/<issue-id>`
  - compare: `<repo>/compare/<baseRev>...symphony/<issue-id>`
  - PR: attached later by human or future automation.

### Artifact Links

Local filesystem links/actions:

- Open run directory: `.symphony/runs/<issue-id>/<attempt>/`
- Open transcript: `transcript.jsonl`
- Open worker outcome: `outcome.json`
- Open orchestrator record: `outcome-record.json`
- Download/copy bundle path: `work.bundle`

If the dashboard is served in a browser, raw filesystem opening may need a local API endpoint
that streams the file or opens the path through the host app.

## Suggested Dashboard API

Borrow the reference Symphony HTTP surface, but adapt it to Switchyard's artifact and Daytona
data.

Minimum:

- `GET /api/v1/state`: current snapshot for overview and active runs.
- `GET /api/v1/issues/<issue-id-or-display-id>`: issue-specific detail.
- `GET /api/v1/runs`: historical run list from `.symphony/runs`.
- `GET /api/v1/runs/<issue-id>/<attempt>`: run record, outcome, parsed transcript summary.
- `GET /api/v1/runs/<issue-id>/<attempt>/transcript`: transcript lines, filterable by event.
- `POST /api/v1/refresh`: best-effort immediate poll/reconcile trigger.

Useful additions:

- `GET /api/v1/sandboxes`: Daytona sandboxes labelled for Symphony.
- `GET /api/v1/sandboxes/<sandbox-id>`: sandbox detail and latest Daytona state.
- `GET /api/v1/config`: loaded workflow config with secrets redacted.
- `GET /api/v1/links/<issue-id>`: all resolved permalinks/deep links for one issue.

Snapshot shape should include:

```json
{
  "generatedAt": "2026-05-04T20:15:30Z",
  "counts": {
    "ready": 3,
    "active": 1,
    "needsAttention": 2,
    "integratedToday": 4
  },
  "capacity": {
    "running": 1,
    "maxConcurrentAgents": 1
  },
  "activeRuns": [],
  "attention": [],
  "recentRuns": [],
  "codexTotals": {
    "inputTokens": 0,
    "outputTokens": 0,
    "totalTokens": 0,
    "secondsRunning": 0
  },
  "rateLimits": null,
  "daytona": {
    "apiUrl": "http://localhost:3000/api",
    "target": "us",
    "snapshot": "symphony-codex-bun",
    "sandboxes": []
  }
}
```

## State And Status Language

Recommended product language:

| Technical state                              | User-facing label       | Notes                                            |
| -------------------------------------------- | ----------------------- | ------------------------------------------------ |
| `todo` + `symphony_ready=false`              | Not ready               | Hidden from active dispatch queue by default     |
| `todo` + `symphony_ready=true` + no blockers | Ready                   | Dispatch candidate                               |
| `in-progress` + `active`                     | Running                 | Active orchestrator work                         |
| `done` + `end`                               | Integrated              | Branch exists; human review/merge still separate |
| `in-progress` + `needs-attention`            | Needs attention         | Human triage and re-arm required                 |
| missing/malformed outcome                    | Outcome invalid         | Show as failure class, not generic error         |
| Daytona `error` / `build_failed`             | Sandbox error           | Needs infrastructure triage                      |
| turn input required                          | Worker blocked on input | Hard failure in v0                               |

Avoid calling a run "complete" unless it is clear whether that means worker completed, bundle
integrated, issue done, or branch merged. Use precise labels: "Turn completed", "Integrated",
"Issue done", "Merged".

## Visual Direction

The dashboard is a switchyard for software. Lean into that literally: 1950s American
freight-railroad operations — enamel signs, signal lamps, switch stands, Solari
split-flap boards, timetables, dispatchers. The railroad is felt, not narrated. The
user still sees "Ready", "Running", "Integrated"; the typography, color, and geometry
do the storytelling.

The handoff chain is a track diagram. States are signal lamps. The slot meter is a
row of switch levers. Run history is a timetable. Once that vocabulary is set, the
rest of the dashboard largely designs itself.

### Metaphor Mapping

Honest handles for the designer; not labels in the UI.

| System object       | Railroad object                                            |
| ------------------- | ---------------------------------------------------------- |
| `fp` issue          | Manifest / waybill                                         |
| Ready queue         | Cars on the inbound siding                                 |
| Dispatch            | Switchman throwing a switch                                |
| Orchestrator        | Yardmaster at the panel                                    |
| Daytona sandbox     | Service track / locomotive shed                            |
| Codex worker turn   | A train moving through the yard                            |
| Artifact bundle     | Freight delivered                                          |
| Host branch         | Made-up train on the outbound siding, ready for review     |
| `symphony_state`    | Aspect on the issue's home signal                          |
| Slot capacity       | Switch lever frame; one lever per concurrent slot          |
| Handoff chain       | Track schematic with a switch at each phase boundary       |
| Run history         | Timetable / train sheet                                    |
| Operator            | Dispatcher                                                 |

### Palette: Enamel Sign

A cream paper / chalk-painted-metal base. Saturated accents pulled from Lionel and
Brunswick enamel signage. High contrast lives in the lamps; everywhere else stays
restrained.

- **Base:** warm cream / buttermilk paper. Ink black for body type. Soft brass
  mustard for rules and dividers.
- **Accents:** tomato red, Brunswick / Pullman green, signal yellow / amber,
  station-board navy, oxidized brass.
- **Use color like a real signalman:** scarce and unambiguous. The cream and ink do
  ninety percent of the work; saturated color earns its place by carrying state. If
  everything is a lamp, nothing is.
- **Dark mode** is open. If pursued later, lean into "night yard" — deep blue-black,
  lit signal lamps, cream type. Defer to v2.

### Signal Lamps (State Coding)

State chips are lamp roundels. Consistent shape and size across the UI; can stack
vertically to mimic a real signal head when an entity carries multiple signals
(durable status plus runtime state, for example).

| Lamp aspect    | State                          |
| -------------- | ------------------------------ |
| Red            | Needs attention                |
| Amber          | Running / in progress          |
| Green          | Integrated                     |
| White          | Ready (clear board)            |
| Blue (lunar)   | Idle / not yet ready           |
| Dark / off     | Not dispatched                 |

Signal lamps are the only place the saturated palette runs free.

### Typography

Three layers, each doing a different job.

| Layer              | Role                                | Type                                                |
| ------------------ | ----------------------------------- | --------------------------------------------------- |
| Base (~90%)        | Body, tables, dense data            | Trade Gothic / Bureau Grot — calm, dense, readable  |
| Structural accents | Labels, section headers, chip text  | Gorton-style engraved (e.g. F37 Gorton)             |
| Moments of delight | Counters, live totals, durations    | Split-flap / Solari-style numerals                  |
| Identifiers        | SHAs, branch names, sandbox ids     | A grotesk mono; first-class typography              |

Trade Gothic carries the room; Gorton gives it edges; split-flap gives it time.

### Geometry Rule

Straight lines, ninety-degree corners, or a single fixed sweep radius modeled on a
real track easement. Curves appear *only* at functional junctions — a switch where
the handoff chain branches, a return loop in an empty state. No decorative curves,
no glassmorphism, no drop shadows. Rules and dividers behave like rails: paired
parallel lines, with crossties as a tertiary divider where rows need to feel like
sleepers.

The handoff chain — `fp issue → orchestrator → sandbox → codex → bundle → branch →
review` — is drawn as a section of track with a switch or signal at each phase
boundary. The "run phase" cell on the active-runs table is a tiny version of the
same diagram with the train's current position lit.

### Illustration Moments

Reserve illustration for moments, not chrome. Everyday surfaces stay quiet;
illustration earns attention by being rare.

- **Empty state (no runs yet):** an empty siding under afternoon light.
- **Fresh integration:** a locomotive pulling into a station platform, or freight set
  onto an outbound siding.
- **Needs attention:** a downed signal, a lantern with broken glass, a chalked
  "BAD ORDER" tag pinned to a car.
- **Stale run / abandoned sandbox:** weathered rolling stock on a side track;
  tumbleweed.
- **Loading / polling:** a slow horizon line with a distant train silhouette inching
  across.
- **Rate-limit hit / upstream throttle:** a closed grade-crossing gate with flashing
  lamps.

The world is unpopulated. No mascots, no anthropomorphic engines, no Thomas-the-
Tank-Engine energy. What's playful is the *machinery* — the switches, lamps, levers,
and boards.

### What To Avoid

- Generic devtool gray-on-black, neon terminal greens, monochrome severity.
- Drop shadows, glassmorphism, decorative gradients, soft fluffy curves.
- Cute mascots or face-on locomotives.
- Overusing color — the saturated palette is precious.
- "Retro" pastiche that drifts into ironic kitsch. The aim is utilitarian period
  equipment that happens to be beautiful, not a theme park.

### Design Principles

- Dense but calm. Operators scan rows and status chips repeatedly.
- IDs, branch names, sandbox ids, and timestamps are first-class typography.
- Tables, timelines, split panes, detail drawers — not decorative cards.
- Color earns its place; signals are the loud surface.
- Live updates without noisy motion. A slow lamp pulse on active rows; split-flap
  numerals can flap on change. Nothing else moves.

### Promising First Viewport

- **Top status strip as a station board:** online/offline lamp, last update, next
  poll, workflow file, Daytona target. Split-flap clock at the right.
- **Four counters as departures-board tiles:** Ready, Running, Needs attention,
  Integrated today. Numbers in split-flap.
- **Main split:**
  - Left: active and attention queues. Each row leads with a lamp roundel, then the
    issue key in mono, then the run phase as a tiny track diagram.
  - Right: selected issue/run detail with link panel and the handoff-chain track
    diagram as the timeline.
- **Bottom strip:** recent completed runs as a timetable — columns aligned like a
  train-sheet entry (issue, departed, arrived, duration, branch, status lamp).

## First Milestone Scope

Build the dashboard around read-only observability first.

In scope:

- Current snapshot from orchestrator memory.
- Historical run records from `.symphony/runs`.
- Parsed `outcome.json` and `outcome-record.json`.
- Transcript summaries and raw transcript view.
- `fp` issue metadata and comments.
- Daytona sandbox list/detail joined by labels.
- Link panel for `fp`, Daytona, Git, and artifact paths.
- Manual refresh trigger.

Out of scope for the first milestone:

- Editing `fp` issue state from the dashboard.
- Re-arming failed runs from the dashboard.
- Deleting or stopping Daytona sandboxes.
- Merging branches.
- Creating PRs.
- Showing secrets, raw auth material, or unredacted env values.

## Data Gaps To Close

The dashboard will be stronger if the orchestrator records a few more fields consistently:

1. **Sandbox id/name in `outcome-record.json`.** The spec relies on Daytona labels for recovery,
   but historical UI should not need to rediscover old sandbox identity.
2. **Run phase events.** Persist a small event log alongside the raw Codex transcript for
   orchestrator phases: claim, sandbox created, upload done, turn started, artifact collected,
   branch created, fp updated.
3. **Token totals per run.** Transcript parsing can infer them, but a final per-run total in the
   orchestrator record makes history cheap.
4. **Changed-file summary.** Derive from the integrated branch or bundle and cache for dashboards.
5. **Check results.** Worker-side checks are informational in v0; capture command names and
   pass/fail summaries if the worker reports them.
6. **External branch/PR URLs.** `symphony_artifact` is free text today. Prefer a structured
   artifact object later.
7. **Daytona usage metrics.** If analytics are enabled, join CPU/RAM/disk seconds and price by
   sandbox id.
8. **Failure class enum.** `symphony_last_error` is human text. Add a machine-readable failure
   class for grouping.

## Source Notes

This brief is grounded in:

- `docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md`
- `docs/architecture/0001-symphony-deviations.md`
- `.fp/extensions/symphony-state.ts`
- `apps/symphony-orchestrator/src/workflow/models.ts`
- `apps/symphony-orchestrator/src/artifact/models.ts`
- `apps/symphony-orchestrator/src/artifact/store.ts`
- `playgrounds/symphony-daytona-playground/src/smoke-app-server.ts`
- `playgrounds/symphony-daytona-playground/src/codex-driver.cjs`
- `references/openai-symphony/SPEC.md`
- `references/openai-symphony/elixir/lib/symphony_elixir/status_dashboard.ex`
- `references/openai-symphony/elixir/lib/symphony_elixir_web/live/dashboard_live.ex`
- `references/openai-symphony/elixir/lib/symphony_elixir_web/presenter.ex`
- `references/brettimus-symphony/SPEC.md`
- `references/brettimus-symphony/src/observability/status-server.ts`
- `references/brettimus-symphony/src/orchestrator/models.ts`
- `references/brettimus-symphony/src/fp/models.ts`
- `references/daytona/libs/sdk-typescript/src/Daytona.ts`
- `references/daytona/libs/sdk-typescript/src/Sandbox.ts`
- `references/daytona/libs/api-client/src/models/sandbox.ts`
- `references/daytona/libs/api-client/src/models/sandbox-state.ts`
- `references/daytona/libs/analytics-api-client/src/models/models-sandbox-usage.ts`
