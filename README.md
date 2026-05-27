<h3 align="center">Switchyard</h3>

<p align="center">
  <strong>Experimental</strong> Software Factory combining <a href="https://github.com/openai/symphony">Symphony</a>, the <a href="https://fp.dev">fp</a> issue tracker, and <a href="https://www.daytona.io/">Daytona</a> sandboxes
</p>

---

> Based on the [fiberplane/otter](https://github.com/fiberplane/otter) template — a light software factory for Effect.ts monorepos with agent-friendly tooling for code quality, documentation, and work tracking.

## Somewhat-quick Start

End-to-end: configure Daytona Cloud credentials, validate GitHub/fp access, arm an `fp` ticket,
dispatch it through the orchestrator, and watch a real Codex worker create a GitHub PR from a
remote Daytona sandbox.

### Prereqs

- `bun` >= 1.3.13, `fp` CLI authenticated against this project.
- `~/.codex/auth.json` on the host (ChatGPT login, not `OPENAI_API_KEY`).
- Daytona Cloud API access and a snapshot with `git`, `gh`, `fp`, `rg`, `jq`, Bun, Codex, drift,
  and ast-grep.
- A GitHub token for this repo with contents read/write, workflows read/write, and pull requests
  read/write.
- Optional: `jq` for prettier log tailing.

```bash
bun install
```

### 1. Configure host secrets

Create `apps/symphony-orchestrator/.env` from `.env.example` and fill in the remote credentials.
The file is gitignored; never put these values in `WORKFLOW.md`.

```bash
cp apps/symphony-orchestrator/.env.example apps/symphony-orchestrator/.env
$EDITOR apps/symphony-orchestrator/.env
```

Minimum values for the remote path:

```bash
DAYTONA_API_KEY=
DAYTONA_SNAPSHOT=
GITHUB_TOKEN=
FP_REMOTE=rest-api
FP_TOKEN=
FP_SERVER_URL=
FP_WORKSPACE=
FP_PROJECT_ID=
SWITCHYARD_CODEX_AUTH=/Users/<you>/.codex/auth.json
```

### 2. Validate GitHub write access

Before spending a Daytona run, validate that the GitHub token can create and delete an E2E branch:

```bash
bun run --filter @switchyard/qa github-token:preflight
```

This prints only token fingerprints and tests both GitHub REST create/delete-ref and isolated
credential-helper-free `git push` create/delete under `symphony/e2e/`.

### 3. Validate the remote Daytona E2E

The canonical remote proof creates a scratch fp issue, a Daytona Cloud sandbox, a GitHub branch,
a non-draft PR, worker-owned fp terminal metadata, and then cleans up the PR, branch, and sandbox.

```bash
SWITCHYARD_REMOTE_DAYTONA_E2E=1 \
SWITCHYARD_REMOTE_DAYTONA_BASE_BRANCH=proposal/remote-daytona-sandboxes \
bun run --filter @switchyard/qa remote-daytona:e2e
```

The runner writes sanitized evidence under `packages/qa/results/`; commit only curated PASS
evidence with `git add -f`.

### 4. Arm a work ticket

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
turn.started → turn.completed → worker.handoff.completed
```

The remote worker owns the GitHub handoff: it pushes an allowed-prefix branch, opens a PR, updates
canonical `symphony_*` fp metadata, and marks the issue terminal. The host verifies fp/PR/base/head
agreement before treating the run as integrated.

### 7. Cleanup

Remote E2E cleanup closes only the matching PR, deletes only the matching branch, and deletes only
Daytona sandboxes with the matching `test_run_id`. For normal dispatches, use Daytona labels such
as `app=symphony`, `fp_issue_id=<internal-id>`, and `run_id=<run-id>` to inspect or prune sandboxes.

To re-arm an issue that ended in `needs-attention` (v1 has `maxAttempts: 1`, so retry is manual):

```bash
fp issue update <id> --status todo \
  --property symphony_state=idle \
  --property symphony_last_error= \
  --property symphony_attempt=0 \
  --property symphony_ready=true
```

### Going deeper

- [`apps/symphony-orchestrator/snapshot/README.md`](apps/symphony-orchestrator/snapshot/README.md) — snapshot build internals + env overrides.
- [`docs/architecture/orchestrator-runone.md`](docs/architecture/orchestrator-runone.md) — pipeline, three-comment cadence, codex auth.
- [`docs/proposals/active/2026-05-26-remote-daytona-sandboxes.md`](docs/proposals/active/2026-05-26-remote-daytona-sandboxes.md) — accepted remote Daytona migration design.
- [`docs/graveyard/daytona-local-compose.md`](docs/graveyard/daytona-local-compose.md) — retired local compose implementation notes.
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
