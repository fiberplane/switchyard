# Append a vertical-slice marker line to README.md

## Context

You are a Codex worker running inside a Daytona sandbox. The local repo is `/workspace/repo`.
The starting commit is tagged `symphony-base`.

This task is a deliberately small, deterministic code change so the Switchyard vertical-slice
QA scenario can verify the end-to-end loop (orchestrator → sandbox → worker → bundle →
integration → fp `done`) without depending on complex worker behavior.

## Task

1. Open `README.md` at the repo root.
2. Append a single new line at the end of the file with this exact text:

   ```
   <!-- vertical-slice-marker: SWYRD QA happy-path run -->
   ```

   (One trailing newline at end-of-file; do not change any existing lines.)

3. Stage and commit the change with a descriptive commit message such as
   `Append vertical-slice marker to README` (commit messages are part of the artifact — the
   orchestrator preserves your full commit history via `git bundle` and the human reviewer reads
   commit messages to understand your reasoning, per spec lines 801-803).
4. (Optional) Make a second commit with a small clarifying tweak — e.g., add a blank line before
   the marker. The vertical slice supports multiple commits per turn; producing two demonstrates
   the bundle preserves history.

## Deliverable

- One or two commits on top of `symphony-base` modifying only `README.md`.
- Final `outcome.json` at `/tmp/.symphony/outcome.json` with `status: "completed"` and a
  `summary` describing what you did.

## Out of scope

- Do **not** modify any file other than `README.md`.
- Do **not** add new files (no test, no doc, no config — keep the diff minimal).
- Do **not** attempt `fp` writes; you have no `fp` credentials (per ADR D4 and spec line 800).
- Do **not** contact the host network; outcome flows through files only (spec lines 810-811).

## Why this task

The verification surface for scenario 01 needs a deterministic before/after. A README append
gives the operator (or grading agent) a single line to grep for after integration:

```
git log -p <baseRev>..symphony/<issue-id> -- README.md
```

(`<baseRev>` is the host-repo SHA captured in scenario 01 step 1; the host repo's default
branch may not be `main` depending on git version + global config.)

If the marker line shows up in a commit on `symphony/<issue-id>`, the worker did the work and
the bundle integration succeeded. If it doesn't show up, the work didn't make it through the
pipeline.
