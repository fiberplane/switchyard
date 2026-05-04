# AGENTS.md

Effect.ts monorepo template with agent-friendly tooling for code quality, documentation, and work tracking.

## Philosophy

**Explicit control flow.** Every branch handled, every error typed. `TaggedError` gives errors identity, `catchTag` forces handling by name. No silent catches, no untyped throws, no bare `new Error`.

**Code shape enforcement.** ast-grep rules enforce architecture, not just style. Errors live in `errors.ts`. External SDK wrappers live in adapter files. `runPromise` only appears at entry points. The rules define the shape of the codebase — read them to understand the architecture.

**Runtime observability.** Structured logging with span context, traces at every boundary. Run with `EFFECT_TRACE=1` to see the full call tree on stdout. The first two pillars enforce the preconditions that make this work.

## Conventions

- `apps/` — Deployable applications (CLIs, APIs, workers)
- `packages/` — Internal shared packages consumed by apps
- Each app and package has its own `package.json` and `tsconfig.json` extending the root
- **Boundary convention**: Adapter files (`*.adapter.ts` or `adapters/`) wrap external SDKs and services that don't have Effect abstractions. Effect platform services (`FileSystem`, `HttpClient`, etc.) are already traced and injectable — use them freely in interior code. See `docs/patterns/boundaries.md`.
- **Schema-first at boundaries**: All external data (HTTP bodies, JSON files, messages) must be validated through `Schema.decodeUnknown` before use. No `as` casts or typed assignments on parsed data, no bare `JSON.parse`. See `docs/patterns/data-validation.md`.
- **App templates**: To build new apps (CLI, API, worker), see `docs/templates/`.

## Apps

| App                                       | Runtime      | Purpose                                      |
| ----------------------------------------- | ------------ | -------------------------------------------- |
| `apps/symphony-orchestrator`              | Bun / Effect | Switchyard orchestrator implementation       |
| `playgrounds/symphony-daytona-playground` | Bun          | Daytona/Codex smoke evidence and experiments |

## Packages

`packages/` is reserved for internal shared packages. It is currently empty.

## Prerequisites

The following tools must be installed on the host machine:

| Tool                | Purpose                                      | Install                                                            |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| **bun**             | Package manager and runtime                  | [bun.sh](https://bun.sh)                                           |
| **fp**              | Issue tracking and work sessions             | [fp.dev](https://fp.dev)                                           |
| **drift**           | Spec-to-code binding and staleness detection | [github.com/fiberplane/drift](https://github.com/fiberplane/drift) |
| **ast-grep** (`sg`) | Custom lint rules                            | [ast-grep.github.io](https://ast-grep.github.io)                   |

## Commands

```bash
bun install                       # Install all deps
bun run lint                      # oxlint
bun run lint:ast                  # ast-grep scan (custom rules)
bun run lint:drift                # drift lint (stale spec check)
bun run format                    # oxfmt
bun run format:check              # Check formatting without writing
bun run typecheck                 # tsgo --noEmit
bun run check                     # lint + ast-grep + drift + typecheck
bun run test                      # Tests (all workspaces)
EFFECT_TRACE=1 bun run <command>  # Enable trace + structured log output
```

`bun run check` does not run tests or `format:check`. Before closing code tasks, run all three:

```bash
bun run test
bun run format:check
bun run check
```

## FP Task Workflow

For issue-backed implementation work, use the repo skill at
`.agents/skills/fp-task/SKILL.md`.

Minimum workflow:

- Load context with `fp context <id>` and `fp issue get <id>`.
- Claim work with `fp issue update <id> --status in-progress`.
- Log meaningful milestones with `fp comment <id> "..."`.
- Commit with the fp issue id in the message.
- Mark done only after auditing acceptance criteria against real evidence.

Code review is mandatory by default for implementation work: use a review subagent unless the user
explicitly opts out or the current agent environment does not provide subagents. If a review skill
or plugin is available, instruct the subagent to use it. Address findings before final
verification. If subagents are unavailable, state that exception clearly, perform a structured
self-review, and ask for human or subagent-capable review before marking the issue done unless the
user tells you to continue.

## Where to Look

| Topic                            | Location                                   |
| -------------------------------- | ------------------------------------------ |
| Effect conventions               | `docs/patterns/effect.md`                  |
| Boundary conventions             | `docs/patterns/boundaries.md`              |
| Data validation at boundaries    | `docs/patterns/data-validation.md`         |
| Coding style                     | `docs/patterns/coding-style.md`            |
| Observability setup              | `docs/patterns/observability.md`           |
| App templates (CLI, API, worker) | `docs/templates/`                          |
| Architecture notes               | `docs/architecture/`                       |
| Proposals (active designs)       | `docs/proposals/active/`                   |
| Experiments and demo evidence    | `docs/experiments/`                        |
| Testing patterns                 | `docs/testing/`                            |
| Retired docs                     | `docs/graveyard/`                          |
| Docs convention guide            | `docs/README.md`                           |
| fp task workflow                 | `.agents/skills/fp-task/SKILL.md`          |
| ast-grep rules                   | `rules/shared/`, `rules/effect/`           |
| ast-grep rule tests              | `rule-tests/shared/`, `rule-tests/effect/` |

## Enforcement

- **oxlint** — Config in `.oxlintrc.json`. Handles standard TypeScript lint rules.
- **oxfmt** — Config in `.oxfmtrc.json`. 2-space indent, 100-char lines, double quotes, import sorting.
- **tsgo** — TypeScript native compiler (preview). Uses root `tsconfig.json`.
- **ast-grep** — Custom rules in `rules/`. These enforce the architectural patterns described above — see `docs/patterns/effect.md` for the full rule table.
- **drift** — Binds specs in `docs/` to source files. `drift lint` flags stale specs, `drift link <spec>` re-stamps.

**After writing any code**, run `bun run test`, `bun run format:check`, and `bun run check`.

## References

Clone upstream repos into `references/` when docs are insufficient. This directory is gitignored and excluded from linting.

```bash
git clone --depth 1 https://github.com/Effect-TS/effect.git references/effect
```

@FP_AGENTS.md
