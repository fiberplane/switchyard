# ADR 0001 — Symphony Deviations

Date: 2026-05-04
Status: Accepted

## Context

Switchyard implements a Symphony-style coordination model: an orchestrator polls a tracker
(`fp`), dispatches coding agents (Codex) to per-issue isolated workspaces (Daytona sandboxes),
and integrates worker outcomes back into the host repo. The upstream Symphony specification at
`references/openai-symphony/SPEC.md` is our reference for shape, naming, and protocol semantics.

The current vertical slice (see
`docs/superpowers/specs/2026-05-04-symphony-daytona-vertical-slice.md`) is a deliberately narrow
demo. Several architectural choices diverge from upstream. This ADR records those choices and
the reasoning behind them so a reader familiar with upstream Symphony can quickly orient on what
we did differently and why.

## Decisions

### D1. Custom property is named `symphony_state`, not `symphony_status`

Upstream and the Brettimus reference implementation both use `symphony_status` for the visible
tracker property. We use `symphony_state` in the Switchyard spec.

Rationale: this is a naming preference, locked in by the parent epic (`SWYRD-ecirajtz`) brief.
The semantics align with `_state` as a coarse runtime indicator rather than a transition log.

### D2. The orchestrator's claim/run state is **in-memory**, not mirrored into `fp`

Upstream Symphony defines a 5-state internal claim machine (`Unclaimed / Claimed / Running /
RetryQueued / Released`) plus an 11-phase run-attempt lifecycle, all in orchestrator memory. The
tracker only carries `Todo / In Progress / Done` filtered through `active_states` /
`terminal_states`.

We considered mirroring a richer state machine into `fp` for demo observability and decided not
to:

- Mirroring transient state into `fp` forces a messy bootstrap-vs-tracker reconciliation dance
  on orchestrator restart.
- Stale `fp` state from a crashed orchestrator becomes a recovery hazard, not a recovery aid.
- Demo observability is satisfied by the protocol transcript and `fp` comments, not by
  chip-color changes in the tracker UI.

What we kept: a 4-value `symphony_state` (`idle` / `active` / `end` / `needs-attention`) as a
human-glance mirror, **explicitly non-authoritative**. Eligibility, dispatch, and retry
decisions do not consult `symphony_state` — they operate on built-in `status` and the
orchestrator's in-memory `running` set.

### D3. Single-orchestrator assumption is load-bearing

Upstream Symphony's "single authoritative orchestrator" is a soft assumption. We make it
load-bearing: there is exactly one orchestrator and no `symphony_orchestrator_id` property in
`fp`. Multiple-orchestrator coordination is a future concern.

Consequence: there is no defensive guard against accidental double-dispatch by a second
orchestrator. The operator is responsible for not running two.

### D4. The orchestrator is the **sole `fp` writer**; the worker has no `fp` credentials

Upstream Symphony explicitly allows the worker to write to the tracker directly:

> Ticket writes (state transitions, comments, PR links) are typically performed by the coding
> agent using tools available in the workflow/runtime environment.
> — `references/openai-symphony/SPEC.md` lines 39–40

We forbid this. The Daytona sandbox does not receive `fp` credentials. The worker communicates
outcome to the orchestrator via a small side-channel artifact (`outcome.json`) that the
orchestrator decodes with Effect Schema and translates into `fp` writes.

Rationale:

- Single source of truth for `fp` writes simplifies reasoning about state.
- Avoids putting `fp` credentials inside a sandboxed environment we don't fully control.
- Keeps the worker's contract narrow: "do code work, write a small outcome file."
- Keeps retry policy out of the worker — the orchestrator decides whether a `failed` outcome
  triggers retry vs. handoff.

Consequence: we have to invent an outcome convention because we forbade the upstream channel.
That invention is one Effect-decoded JSON file with a 2-field schema (`status`, `summary`).
Tracked as `SWYRD-jjlifoqq` to revisit once we have richer use cases that argue for relaxing the
boundary.

### D4b. Minimal `fp` property surface

The fp surface area for runtime metadata is exactly five properties: `symphony_ready`,
`symphony_state`, `symphony_attempt`, `symphony_artifact`, `symphony_last_error`. Three other
candidates were considered and not registered:

- **`symphony_orchestrator_id`** — single-orchestrator assumption (D3) makes this redundant.
- **`symphony_sandbox_id`** — recoverable from Daytona labels (sandboxes are labelled with
  `fp_issue_id`); no need to duplicate that identity into `fp`.
- **`symphony_base_rev`** — captured at dispatch in `outcome-record.json` on disk; no durable
  `fp` consumer needs it.

### D5. Retry is **human-gated**; no auto-retry

Upstream Symphony defines exponential backoff (10s × 2^(attempt-1), capped 5m), separate stall
detection, and a separate fixed-delay continuation retry after clean turn exits.

We do **none** of this. Every worker failure parks the issue at
`symphony_state=needs-attention` and waits for a human to re-arm it by transitioning `status`
from `in-progress` back to `todo`.

Rationale:

- The meetup demo doesn't have time to demonstrate retry on stage; auto-retry adds complexity
  with no demo payoff.
- Human-gated handoff is the right _default_ until we know which failures are flaky-transient
  vs. genuinely-broken. Auto-retrying broken code wastes Daytona resources.
- `agent.maxAttempts` is preserved at `1` (no auto-retry) so the config knob exists for future
  policy. `agent.maxRetryBackoffMs` is not present — no auto-retry means no backoff timer.

Continuation turns (re-poll tracker after clean turn exit, possibly start another turn on the
same live thread) are deferred — they become essentially free under `codex app-server` and are
tracked as `SWYRD-clnybkgo`.

### D6. Source handoff is **archive upload**; sandbox has a single-commit history

Upstream Symphony assumes per-issue workspaces with full git history (typically `git worktree`).
That model breaks across the sandbox boundary because:

- Worktrees don't cross container/remote boundaries (Brettimus called this out explicitly).
- The sandbox doesn't have GitHub credentials in v1.

We use **archive upload**: the orchestrator runs `git archive HEAD` on the host, uploads the
tarball into the sandbox, and the sandbox creates a fresh git repo with one initial commit
tagged `symphony-base`. The worker commits on top of that tag.

Consequence: the worker cannot `git log` past `symphony-base`. Exploratory tasks that benefit
from real history are limited. Tracked as `SWYRD-yailwgkj` for a future iteration that may
switch to volume mounts, GitHub clones, or richer host syncs.

### D7. Artifact return is **`git bundle`**; integration is **branch-on-host**

`git bundle create work.bundle HEAD` round-trips full commit history (the worker's
commits and commit messages preserved end-to-end). The bundle must be **self-contained** — `HEAD`,
not `symphony-base..HEAD`. The host repo never had `symphony-base` (the tag is created inside the
sandbox by D6's setup), so a thin range-bundle would fail `git fetch` with "Repository lacks these
prerequisite commits." The single-commit-history invariant from D6 makes the self-contained
bundle cheap: it carries `symphony-base` plus the worker's commits, nothing more. The orchestrator
fetches the bundle into the host repo as `symphony/<issue-id>` (which now anchors at the bundle's
`symphony-base` commit). No worktree directories proliferate; the host repo accumulates
`symphony/*` branches that humans can review and merge. The orchestrator never auto-merges to
`main`.

Patch-based artifacts (`git diff --binary > symphony-result.patch`) were rejected because they
flatten history into a single squashed diff — the commit-by-commit thought process is a primary
review artifact, not noise.

### D8. `codex app-server`, not `codex exec --json`

Upstream Symphony defaults to `codex app-server` and is structured around its session/thread/turn
model. The Brettimus reference has a working ~1200-line app-server client we adapt. Benefits:

- The protocol stream **is** the conversation transcript — no separate logging needed.
- Native session/thread identity, stable across protocol versions.
- Schema-enforced turn-completion events; no parsing fragility around JSONL stdout drift.
- Continuation turns become a small extension (D5 / `SWYRD-clnybkgo`).
- We become a more faithful Symphony implementation.

Cost: ~1000–1500 lines of protocol client. The Switchyard implementation **does not** copy
Brettimus's single-file runner — we decompose into transport / events / session / turn modules
so the protocol surface stays inspectable.

### D9. Worker-side checks are informational; orchestrator does **not** re-run

The orchestrator does not run any health checks against the integrated branch on the host. The
worker may run checks inside the sandbox (e.g., `bun run check`) but those results are not
consumed by the orchestrator beyond informational logging.

Rationale: the demo will use Switchyard to develop Switchyard. The project's own CI on the
`symphony/<issue-id>` branch enforces health on push/merge — orchestrator-side re-running would
be redundant for our specific use case.

Tracked as `SWYRD-ovvmzqxw` for a future iteration where the orchestrator should run a
configurable health probe before posting a `completed` outcome.

## Consequences

Positive:

- The spec stays small and demo-ready. Each deviation buys clarity at the cost of reach.
- Worker contract stays narrow: read prompt, edit code, commit, write `outcome.json`. No tracker
  SDK. No retry semantics. No filing follow-up issues.
- Orchestrator is the single source of truth for `fp` writes. Reasoning about state is local to
  one process.
- The deferral list is explicit and tracked; future-us has a punch list, not surprises.

Negative:

- We are not directly substitutable with upstream Symphony or with implementations that follow
  upstream literally. Some of our deviations (worker can't write `fp`, no auto-retry) are real
  capability deltas.
- `fp` UI does not show rich runtime chip transitions; demo narrative for "what is the
  orchestrator doing right now" relies on `fp` comments and the orchestrator's stdout/log.
- Restart recovery has fewer breadcrumbs than upstream; we rely on Daytona labels rather than
  tracker properties.

## Tracking

Open follow-up decisions, captured as fp issues under epic `SWYRD-uouprnfv`:

- `SWYRD-oxevvenq` — Worker follow-up reporting format and orchestrator filing behavior
- `SWYRD-clnybkgo` — Continuation-turn behavior under `codex app-server`
- `SWYRD-yailwgkj` — Full git history transfer to sandbox
- `SWYRD-ovvmzqxw` — Orchestrator-side check verification
- `SWYRD-jjlifoqq` — Decide whether the worker should write `fp` directly
- `SWYRD-zituhadq` — Orchestrator policy for branch collision on integration retry
