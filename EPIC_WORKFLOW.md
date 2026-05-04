# Epic Workflow (draft)

A working draft of how we break a hardened spec into implementable leaves and walk each one to done. Currently used for the **Switchyard vertical-slice orchestrator** epic (`SWYRD-gjsqxsyt`); will generalize as we learn what's load-bearing.

> This doc is intentionally a draft — update it after each leaf with workflow-shape feedback. Once the shape stabilizes across two or three epics, promote to a permanent location under `docs/`.

## Sources of truth for this epic

- **Spec:** `docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md`
- **ADR:** `docs/architecture/0001-symphony-deviations.md`
- **Smoke evidence + protocol field shapes:** validated by `SWYRD-gxgqehxl` (commit `379e422`)

## Approach

- Leaves first, then build up to the root.
- Each leaf is one `fp` child issue under the implementation epic.
- Stable ticket shape (below) so the implementer never has to ask "what goes in this section."
- Implementation follows `~/.claude/commands/brett-task.md` with adaptations called out below.

## Ticket shape

Every leaf ticket has these sections, in order. Skip a section if genuinely empty (write "n/a" so it's clear you didn't forget) but never reorder.

1. **Spec sections.** Pointer(s) to the relevant headings in the spec / ADR / focused doc.
2. **Depends on.** Explicit list of prior leaves whose output this consumes (e.g., "`SWYRD-ajxqlrhn` for the `apps/symphony-orchestrator/` workspace scaffolding"). If none, write "first leaf".
3. **Produces.** What callers will receive — services, schemas, types, services exposed via `Layer`.
4. **Out of scope.** What this leaf does _not_ own (so consumers know they're picking it up later, and the implementer doesn't accidentally widen scope).
5. **Files to create.** Concrete tree.
6. **Tracer bullet (red / green).** Numbered red → green steps that walk the implementer through TDD. Cadence: **one test at a time** — write a failing test, drive it green, refactor, then write the next failing test. **Not** "write all tests first, then implement" — the loop is `RED → GREEN → RED → GREEN`, not `RED RED RED → GREEN GREEN GREEN`. Each red/green cycle is a small commit-able unit.
7. **Decisions you'll need to make.** Design judgment calls flagged as prompts so the implementer doesn't make them implicitly. (e.g., "Schema defaults vs. require-explicit?", "Take a dependency on `WorkflowService` or accept the value at `Layer` wiring time?")
8. **E2E verification.** Exact commands with `cwd` where ambiguous (see **Verification commands** below).
9. **Self-reflection prompts.** Questions to answer in the closing fp comment about gaps found while implementing alone.
10. **Integration reflection prompts.** Questions about gaps that surface when wiring with siblings. For early leaves these are usually "n/a — revisit when first sibling consumes this." For later leaves they're real.
11. **Brettimus inspiration.** Specific files with line ranges when known. Vague pointers ("for schema patterns") aren't useful — name the file.
12. **Acceptance.** Bullet checklist for closing the issue.

## Implementation workflow per leaf

Loosely follows `~/.claude/commands/brett-task.md`. The mandatory subagent self-review (step 5) is the most important addition.

1. **Verify project is in a good state.** `bun run check`, `bun test`. Fix anything broken before starting.
2. **Read all ticket context.** `fp context <id>` for the leaf and its parent epic; read the spec section(s); skim Brettimus inspiration files.
3. **Implement to the tracer-bullet plan.** Walk the numbered red → green steps **one at a time**: write the first failing test, drive it green, refactor, commit; then write the next failing test, drive it green, refactor, commit. Do not write all tests up front. Log progress on the fp issue at meaningful checkpoints: `fp comment <id> "..."`.
4. **Re-verify project state.** `bun run check`, `bun test`.
5. **Mandatory subagent self-review.** Invoke a code-review subagent on the diff for this leaf. The subagent receives:
   - The ticket text (`fp context <id>`).
   - The relevant spec section.
   - The diff (`git diff <merge-base>...HEAD` or `git diff` for uncommitted).
   - The Brettimus inspiration links.
   - The conventions in `AGENTS.md` and `docs/patterns/`.

   Subagent returns severity-graded refinement points. The implementer:
   - **Posts a comment on the fp issue** summarizing what the subagent flagged (severity counts at minimum; specific blockers/important items quoted or paraphrased). This makes the review surface visible alongside the issue.
   - **Addresses or explicitly acknowledges each point.** Anything not fixed gets a one-line "acknowledged because X" note in the same comment so it's clear nothing was silently dropped.

6. **Final verification.** `bun run check`, `bun test`. All green before committing the response to review.
7. **Commit.** Descriptive commit message ending with the fp issue id.
8. **Reflection comment.** Post answers to the self-reflection prompts on the fp issue. Fill integration-reflection answers if any siblings now consume this leaf; otherwise mark it for later revisit.
9. **Drift step (see policy below).** If this leaf's responsibility deserves its own focused doc, split it out now and `drift link` the source files to the focused doc.
10. **Mark issue done.** `fp issue update --status done <id>`.

## Backport policy

The prompt every leaf answers in its reflection comment:

> Did you make a decision a sibling will need to know about? If yes, write it into the right place in the spec tree.

The spec tree, in order of preference:

- **Focused doc** (`docs/architecture/<topic>.md`) — if one exists for this responsibility, the decision lives here. Source files already `drift link` to it, so writing here keeps the contract co-located with the consumers.
- **ADR** (`docs/architecture/0001-symphony-deviations.md`) — if the decision diverges from upstream Symphony or another reference implementation. ADR captures the _why_, not the per-leaf shape.
- **Umbrella spec** (`docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md`) — for cross-cutting facts not yet pulled into a focused doc, or for shape that matters across multiple leaves. Default destination when no focused doc exists yet.

Edit cadence:

- **Inline edit, this PR** — typos, missing fields, exact-shape fixes, single-line clarifications a sibling will need. Default lean.
- **Sibling fp ticket** — new sections, scope shifts, decisions that touch multiple leaves, or anything that requires structural rework of a doc.

The "did you make a decision a sibling will need to know" framing matters because the artifact leaf surfaced two implementation decisions (path-segment rule, JSON write shape) that were classed as "no spec correction" — but a sibling consuming the artifact module will need to know both. Bias toward writing them down somewhere in the tree; absence of contradiction is not the same as absence of a sibling-relevant fact.

The reflection comment must say which destination was used (or that no backport was needed and why).

## Drift binding policy

`drift link` is the right tool, but it has a signal-to-noise trap: if every code change in the orchestrator binds back to the v1 spec, the spec becomes a broad target with hundreds of links and `drift lint` stops being informative.

The intended pattern:

- The v1 spec at `docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md` is the umbrella design doc.
- As each leaf's responsibility gets concrete enough to stand on its own, **split that responsibility into a focused doc under `docs/architecture/<topic>.md`** (e.g., `configuration-parsing.md`, `artifact-store.md`, `app-server-protocol.md`).
- The focused doc owns the contract for that responsibility. It cross-links _up_ to the spec section it originated from.
- Source files in `apps/symphony-orchestrator/` `drift link` to the **focused doc**, not directly to the umbrella spec.

Each leaf ticket therefore asks: _"is this leaf's responsibility stable enough to deserve its own focused doc?"_

- **Yes** → during implementation, split the relevant section out of the spec into `docs/architecture/<topic>.md`. The split is part of this leaf's PR. Add `drift link` from the new source files to the focused doc.
- **No** → spec section may need to grow / settle first. Skip the drift step for this leaf; revisit when the responsibility's shape stabilizes (often after a sibling forces a real interface).

The reflection comment notes which path was taken and why.

## Verification commands

Canonical commands live in `AGENTS.md` (which is being tightened in flight). Until that lands, the working set is:

- `bun run check` — full lint + format + typecheck + ast-grep, **from repo root**.
- `bun test` — all workspaces, **from repo root**.
- `bun test --cwd apps/<app>` — single-workspace test run.
- `bun run typecheck`, `bun run lint`, `bun run format` — individual stages.
- `EFFECT_TRACE=1 bun run <command>` — surface tracing + structured logs when debugging.

When `AGENTS.md` adds canonical leaf-level commands, prefer those.

## Two-axis reflection rationale

Two reflection sections exist because they catch different gaps:

- **Self-reflection.** Catches gaps found _while implementing alone_ — the spec was unclear on env-var interpolation; the YAML key style needed picking; a default value made more sense than a runtime check. These are introspective.
- **Integration reflection.** Catches gaps found _when wiring with a sibling_ — your schema doesn't quite match what the sibling is producing; an interface mismatch forced an adjustment somewhere; a layered service boundary felt off. These are dialogic.

For early leaves, integration reflection is usually "n/a — no sibling consumes this yet." When the first sibling does consume it, the implementer of _that_ sibling re-opens this leaf's issue and fills the integration-reflection section with what they hit. This keeps the loop tight without forcing speculative answers up front.

## Conventions to inherit

- Effect patterns from `references/brettimus-symphony/` (`Context.Tag.Class`, `Layer`, Schema-at-boundaries via `Schema.decodeUnknown`, `Data.TaggedError`).
- Boundary convention: external SDKs/CLIs in `*.adapter.ts`. Effect platform services (`FileSystem`, `HttpClient`) used freely.
- Errors live in `errors.ts`. `runPromise` only at entrypoints. (See `docs/patterns/effect.md` and `AGENTS.md`.)
- Tests use `bun test` with `*.test.ts` colocated under a `test/` directory in each workspace.

## Open questions about this workflow

- Should the subagent self-review have a **single canonical prompt template** the implementer reuses for every leaf, so reviews stay consistent? Probably yes — file as a follow-up once the next leaf is in flight.
- When does a focused `docs/architecture/<topic>.md` doc land — at the moment of splitting, or as part of an earlier leaf? Current rule: split lazily, in the PR for the first leaf whose responsibility it covers cleanly.
- How do we keep this workflow doc itself from going stale? Manually — we'll update it as we learn what's load-bearing and what's noise. No automatic trigger; the implementer or reviewer of any leaf can suggest an edit when the doc starts to drift from how we actually work.
