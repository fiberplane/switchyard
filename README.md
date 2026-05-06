<h3 align="center">Switchyard</h3>

<p align="center">
  **Experimental** Software Factory combining [Symphony](https://github.com/openai/symphony), the [fp](https://fp.dev) issue tracker, and [Daytona](https://www.daytona.io/) sandboxes
</p>

---

> Based on the [fiberplane/otter](https://github.com/fiberplane/otter) template — a light software factory for Effect.ts monorepos with agent-friendly tooling for code quality, documentation, and work tracking.

## Quickstart for demo participants

End-to-end: clone, bring up a local Daytona, arm an `fp` ticket, dispatch it
through the orchestrator, and watch a real Codex worker land a
`symphony/<id>` branch on your local repo.

### Prereqs

- `docker` (or OrbStack on macOS).
- `bun` >= 1.3.13, `fp` CLI authenticated against this project.
- `~/.codex/auth.json` on the host (ChatGPT login, not `OPENAI_API_KEY`).
- Optional: `jq` for prettier log tailing.

The Daytona stack is vendored in-repo at
`apps/symphony-orchestrator/daytona/` — no upstream clone required. See
[`docs/architecture/daytona-local-setup.md`](docs/architecture/daytona-local-setup.md)
for the long-form setup notes; the short version is the steps below.

```bash
bun install
```

### 1. Bring up the local Daytona stack

```bash
bun run --filter @switchyard/symphony-orchestrator daytona:up
curl -sf http://localhost:3000/api/health   # → {"status":"ok"}
```

First run pulls multi-GB images and takes a few minutes. Subsequent
up/down cycles are sub-30s with a warm cache.

### 2. Provision an API key + build the snapshot

The dashboard onboarding key is read-scoped — it cannot create snapshots.
Create a write-scoped key, then build the `symphony-codex-bun` snapshot
the orchestrator dispatches into:

```bash
open http://localhost:3000/dashboard
# Log in: dev@daytona.io / password (upstream dev defaults).
# Dashboard → API Keys → New → grant write:snapshots + delete:snapshots.

DAYTONA_API_KEY=<your-key> \
  bun run --filter @switchyard/symphony-orchestrator snapshot:build
```

`snapshot:build` is idempotent: it early-exits if `symphony-codex-bun` is
already `active`. First build is 3–6 minutes (apt + npm + bun installer).

### 3. Inject your key into `WORKFLOW.md`

`WORKFLOW.md` at the repo root is the operator config. The committed
`sandbox.apiKey` is bound to a different machine's Daytona — replace it
with your own:

```bash
$EDITOR WORKFLOW.md   # paste your write-scoped key into sandbox.apiKey
```

The key authorizes `localhost:3000` only (per-machine). Do not commit the
edit. `WORKFLOW.example.md` is the annotated reference for each field.

### 4. Arm a demo ticket

Flip an `fp` issue's `symphony_ready` flag. The orchestrator polls every
`polling.intervalMs` (default 5s) and dispatches eligible issues on the
next tick.

```bash
# Use a known-good seed, or create one:
fp issue create --title "demo: tiny doc edit" \
  --description "Add a one-line note to docs/README.md crediting demo participants." \
  --property symphony_ready=true
```

For an existing ticket: `fp issue update <id> --property symphony_ready=true`.

### 5. Dispatch

The package ships a `dispatch` script that wires `EFFECT_TRACE=1`,
`LOG_LEVEL=debug`, an absolute workflow path (resolved against `INIT_CWD`
to survive `bun --filter` cwd switching), and a tee'd log:

```bash
bun run --filter @switchyard/symphony-orchestrator dispatch
# Logs land in /tmp/orchestrator.log (override: ORCHESTRATOR_LOG=...)
tail -f /tmp/orchestrator.log | jq -c .
```

### 6. Watch the lifecycle

The orchestrator emits structured log events as the issue flows through the
pipeline:

```
candidate.selected → claim.acquired → sandbox.created → source.uploaded →
turn.started → turn.completed → bundle.decoded → integration.succeeded →
fp.done
```

Three `fp` comments land alongside: `Dispatched to sandbox <uuid>`,
`Worker turn completed; integrating`, then on success the worker's
`outcome.summary` (verbatim). The result is a `symphony/<id>` branch on
your local repo:

```bash
git log --oneline symphony/<id>
git diff symphony/<id>~1..symphony/<id>   # clean diff (synthetic-base aware)
```

Per-run artifacts live under `.symphony/runs/runs/<id>/<attempt>/`
(`outcome.json`, `outcome-record.json`, `transcript.jsonl`, `work.bundle`).

### 7. Cleanup

`autoDeleteInterval: -1` in `WORKFLOW.md` keeps sandboxes alive for forensic
SSH after a run. Prune them via the Daytona dashboard or by Daytona label
`app=symphony` / `fp_issue_id=<internal-id>`. To re-arm an issue that ended
in `needs-attention` (v1 has `maxAttempts: 1`, so retry is manual):

```bash
fp issue update <id> --status todo \
  --property symphony_state=idle \
  --property symphony_last_error= \
  --property symphony_attempt=0
```

To shut everything down:

```bash
bun run --filter @switchyard/symphony-orchestrator daytona:down
```

(`down -v` — drops volumes, including your dashboard key. Drop `-v` in the
script if you want to preserve state across restarts.)

### Going deeper

- [`docs/architecture/daytona-local-setup.md`](docs/architecture/daytona-local-setup.md) — long-form Daytona setup, gotchas.
- [`apps/symphony-orchestrator/daytona/README.md`](apps/symphony-orchestrator/daytona/README.md) — vendored stack details.
- [`apps/symphony-orchestrator/snapshot/README.md`](apps/symphony-orchestrator/snapshot/README.md) — snapshot build internals + env overrides.
- [`docs/architecture/orchestrator-runone.md`](docs/architecture/orchestrator-runone.md) — pipeline, three-comment cadence, codex auth.
- [`docs/architecture/`](docs/architecture/) and [`docs/patterns/`](docs/patterns/) — design notes and Effect conventions.

## Philosophy

**Explicit control flow.** Every branch handled, every error typed. Effect makes failure cases visible in function signatures — `TaggedError` gives errors identity, `catchTag` forces you to handle them by name. No silent catches, no untyped throws, no bare `new Error`. You can read any function and know exactly what can go wrong.

**Code shape enforcement.** ast-grep rules enforce architecture, not just style. Tagged errors must live in `errors.ts`. I/O must live in adapter files. `runPromise` can only appear at entry points. The rules define the shape of the codebase — when an agent reads them, it understands the architecture. See the [full rule table](#ast-grep-rules) below.

**Runtime observability.** Structured logging with span context, traces at every boundary. Set `EFFECT_TRACE=1` and see the full call tree, timings, and correlated logs on stdout. This works because the first two pillars enforce the preconditions: all I/O goes through traced Effect services, log calls use structured annotations, and spans are required at boundaries. See `docs/patterns/observability.md` and `docs/patterns/boundaries.md`.

## Getting started

Install the [prerequisites](#prerequisites), then:

```bash
bun install
```

Start your coding agent in this repo and start building. See `AGENTS.md` for the full command reference, enforcement rules, and conventions.

## Tools

| Tool                                               | Role                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| [bun](https://bun.sh)                              | Package manager and runtime                                          |
| [oxlint](https://oxc.rs) + [oxfmt](https://oxc.rs) | Linting and formatting                                               |
| [tsgo](https://github.com/microsoft/typescript-go) | TypeScript native compiler (preview)                                 |
| [ast-grep](https://ast-grep.github.io)             | Custom TypeScript lint rules (Effect-specific patterns)              |
| [drift](https://github.com/fiberplane/drift)       | Binds documentation specs to source code; detects when docs go stale |
| [fp](https://fp.dev)                               | Local-first issue tracking with lifecycle extensions                 |

## Structure

```
apps/           Deployable applications (CLIs, APIs, workers)
packages/       Internal shared packages
docs/           Conventions, templates, architecture notes, proposals, experiments
rules/          ast-grep lint rules (shared + Effect-specific)
references/     Shallow clones of upstream repos (gitignored)
.fp/extensions/ fp lifecycle extensions
```

## References

`references/` is gitignored and excluded from linting/formatting. Clone upstream repos here when you want agents to read the source directly. Recommended clones for this project:

```bash
git clone --depth 1 https://github.com/Effect-TS/effect.git references/effect
git clone --depth 1 https://github.com/daytonaio/daytona.git references/daytona
git clone --depth 1 https://github.com/openai/symphony.git references/symphony
```

## ast-grep rules

Custom lint rules in `rules/`, run via `bun run lint:ast`.

**Shared** (all TypeScript):

| Rule                   | What it catches                                       |
| ---------------------- | ----------------------------------------------------- |
| `no-dynamic-import`    | Dynamic `import()` — use static imports               |
| `no-else-after-return` | Unnecessary `else` after `return` — use early returns |
| `no-foreach`           | `.forEach()` — use `for...of`                         |

**Effect** (apps and packages):

| Rule                      | What it catches                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `no-bare-new-error`       | `new Error()`, `new TypeError()`, etc. — use TaggedError or let unknowns propagate  |
| `no-console-log`          | `console.*` — use `Effect.log`                                                      |
| `no-direct-fs`            | Direct `node:fs` imports — use Effect's FileSystem service                          |
| `no-fetch-in-effect`      | `Effect.tryPromise` wrapping `fetch()` — use `@effect/platform`'s `HttpClient`      |
| `no-interface-in-models`  | `export interface` in models — use `Schema.Struct`                                  |
| `no-interpolated-logging` | Template literals or concatenation in log calls — use structured annotations        |
| `no-manual-json-decode`   | `Effect.try({ try: () => JSON.parse(...) })` — use `Schema.parseJson(Inner)`        |
| `no-manual-tag-check`     | Manual `._tag` checks — use `Effect.catchTag` or `Match.tag`                        |
| `no-runpromise-in-effect` | `Effect.runPromise`/`runSync` inside Effect code — use `yield*` or boundary pattern |
| `no-silent-catch`         | `Effect.catchAll` without logging — always log before recovering                    |
| `no-throw-in-effect`      | `throw` in Effect generators — use `Effect.fail`                                    |
| `no-try-catch`            | `try/catch` in Effect code — use `Effect.try` or `Effect.catchTag`                  |
| `tagged-error-location`   | `Data.TaggedError` outside `errors.ts` — keep error definitions co-located          |
| `use-tagged-error`        | `class X extends Error` — use `Data.TaggedError`                                    |

## fp extensions

Extensions in `.fp/extensions/` hook into fp's issue lifecycle to enforce workflow quality.

### `auto-done`

Manages parent/child issue lifecycle automatically.

- **Pre-hook**: blocks marking a parent issue as done if any children are still open
- **Post-hook**: when the last child is marked done, auto-marks the parent done

### `check-before-done`

Gates the done transition on passing checks.

Runs `bun run check` (ast-grep + drift + typecheck) before allowing an issue to move to done. Configurable via `.fp/config.toml`:

```toml
[extensions.check-before-done]
checks = "bun run check"  # comma-separated commands
```

### `done-reminder`

Prints a reminder to stderr when an issue transitions to done, prompting the agent to:

- Run code review (via subagent) if the work was non-trivial
- Update `docs/` with architectural or flow decisions, using the drift skill to link specs to relevant source files

## Prerequisites

### bun

```bash
curl -fsSL https://bun.sh/install | bash
```

See [bun.sh](https://bun.sh) for more options.

### fp

```bash
curl -fsSL https://setup.fp.dev/install.sh | sh -s
```

See [fp.dev](https://fp.dev) for more info.

### drift

```bash
curl -fsSL https://drift.fp.dev/install.sh | sh
```

See [github.com/fiberplane/drift](https://github.com/fiberplane/drift) for more info.
