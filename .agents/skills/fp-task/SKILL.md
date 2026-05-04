---
name: fp-task
description: Use when picking up, implementing, verifying, committing, or closing an fp issue in this Switchyard repo, especially when the user mentions an fp/SWYRD issue id or asks to work a task through acceptance.
---

# FP Task

Use this workflow for issue-backed implementation work in Switchyard.

## Start

1. Inspect repo state with `git status --short`.
2. Load issue context:
   - `fp context <id>` or the exact context command the user gave.
   - `fp issue get <id>`.
   - If the issue names a parent, epic, dependency, spec, or ADR, load that too.
3. Establish a baseline before editing:
   - Run relevant scoped checks for the touched workspace when the issue scope is clear.
   - Run root checks for broad, cross-workspace, or unclear scope.
   - If a baseline check is too expensive or unrelated, record why it was skipped.
   - If the baseline is already failing, capture the failure before making changes.
4. Claim the task unless the user only asked for analysis:
   - `fp issue update <id> --status in-progress`.
   - `fp comment <id> "Starting work: ..."`.

## Understand

Map the issue into concrete deliverables before editing:

- Files to create or change.
- Commands and gates to run.
- Acceptance criteria and tracer bullets.
- Required fp comments, reflections, commit attachments, or status changes.
- Docs, drift, or spec backport obligations.
- Parent/child issue behavior, especially auto-close side effects.

Read linked specs and local docs before writing code. Let existing repo patterns decide structure.

## Implement

- Keep changes scoped to the issue.
- Preserve unrelated dirty work.
- Use `fp comment <id> "..."` at meaningful milestones.
- If docs describe changed behavior, update docs in the same change and use the `drift` skill when bindings are involved.
- Prefer scoped checks while iterating. Inspect the workspace `package.json` first and run only scripts that exist. Use exact package names or path selectors, for example:
  - `bun run --filter @switchyard/symphony-orchestrator test`
  - `bun run --filter ./playgrounds/symphony-daytona-playground typecheck`

## Review

Review is mandatory for implementation work unless the user explicitly opts out or the current
environment cannot run subagents.

1. Ask a review subagent to inspect the diff for correctness, missed requirements, regressions,
   and test gaps.
2. If a review skill or plugin is available, instruct the subagent to use it.
3. Give the reviewer issue context, acceptance criteria, and the current diff. Do not ask for a
   rubber stamp.
4. Address actionable findings before final verification. If a finding is intentionally not
   addressed, explain why in the final fp comment.

If subagents are unavailable, state that exception clearly, perform a structured self-review, and
ask for human or subagent-capable review before marking the issue done unless the user tells you to
continue.

## Verification

Before closing an implementation task, run root gates:

```bash
bun run test
bun run format:check
bun run check
```

Notes:

- `bun run check` runs oxlint, ast-grep, drift, and typecheck.
- `bun run check` does not run tests or `format:check`.
- Use scoped formatting during development. Run root `bun run format` only when root
  `format:check` must be made green, and call out formatter-only churn.

## Completion Audit

Before marking done:

- Restate the issue as concrete requirements.
- Check each requirement against files, tests, command output, fp comments, and commits.
- Confirm fixtures or verifier suites actually cover the acceptance criteria.
- Treat missing evidence as incomplete.
- Confirm parent/epic status separately; do not let child completion imply the whole epic is done.

## Commit And Close

1. Stage only the intended work.
2. Commit with the fp issue id in the message.
3. Post required reflection or final comment.
4. Mark done:

   ```bash
   fp issue update <id> --status done
   ```
