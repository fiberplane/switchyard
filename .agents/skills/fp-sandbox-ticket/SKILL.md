---
name: fp-sandbox-ticket
description: "Use when an agent is inside a remote Daytona sandbox working a Switchyard fp issue through implementation, verification, non-draft GitHub PR creation, PR babysitting, and fp property updates via REST no-clone mode."
metadata:
  short-description: Complete Switchyard fp tickets from Daytona
---

# fp Sandbox Ticket

You are inside a disposable remote Daytona sandbox. Treat the prompt as a full
issue-to-PR workflow, not as a coding-only task. The orchestrator handed you a
cloned repo, a pinned base SHA, a deterministic branch, a run id, a Daytona
sandbox id, GitHub credentials in process environment, and fp REST credentials in
process environment.

## Progressive References

Load these only when needed:

- [references/fp-rest.md](references/fp-rest.md): required before reading or updating fp issues, comments, attachments, or custom properties from the sandbox.
- [references/implementation.md](references/implementation.md): required before editing code, verifying work, collecting evidence, or running review passes.
- [references/pr-babysitting.md](references/pr-babysitting.md): required before opening or continuing a PR, checking CI/reviews, fixing failures, or deciding whether to hand off.

## Ground Rules

- Use REST fp from a non-repo directory, normally `/tmp/.symphony/fp-rest`.
- Never print tokens or write credentials into repo files, shell profiles, git remotes, artifacts, PR text, issue comments, transcripts, or diagnostics.
- Use `gh` for PR creation, PR metadata, checks, and review comments. Do not run `gh auth login`.
- Use `GH_TOKEN`/`GITHUB_TOKEN` for `gh`; use `GIT_ASKPASS` for git push/fetch. Never put a token in a remote URL.
- Open a full non-draft PR unless the user explicitly asks for a draft.
- Babysitting is required. Do not stop at PR creation when checks or review feedback are still actionable.
- Preserve unrelated user/author changes when continuing an existing branch or PR.
- Use package scripts from `package.json`; do not invent parallel commands when scripts exist.

## Required fp Properties

Set these custom properties as soon as each value is known:

- `symphony_branch`
- `symphony_pr_url`
- `symphony_pr_number`
- `symphony_base_sha`
- `symphony_head_sha`
- `symphony_run_id`
- `symphony_sandbox_id`

Do not use `symphony_artifact`; the old bundle/artifact return path is retired.

## Workflow

1. Bootstrap and baseline:
   - Read [references/fp-rest.md](references/fp-rest.md).
   - Validate non-secret fp env, GitHub auth, repo state, branch/base SHA, and required tooling.
   - Run a cheap baseline check when practical; if the sandbox cannot run it, record the limitation.

2. Read fp context:
   - Fetch the target issue, comments, parent, siblings, dependencies, and referenced docs.
   - Do not edit code until acceptance criteria and blockers are clear.

3. Prepare branch and coordinate:
   - Read `AGENTS.md` and relevant docs.
   - Create or reset the deterministic branch from the pinned base SHA provided by the orchestrator.
   - Comment on the fp issue with sandbox id, run id, branch, and known PR if one already exists.

4. Implement:
   - Read [references/implementation.md](references/implementation.md).
   - Keep changes scoped to the issue and local patterns.
   - Comment progress at meaningful milestones.

5. Local verification gate:
   - Run the narrowest meaningful checks first, then broaden when risk warrants it.
   - Record exact commands and degraded verification clearly.

6. Review gate:
   - Review your own diff for correctness, secrets, tests, and unrelated changes.
   - Run available strict/code-review subagents or skills.
   - Fix justified findings and record material false positives or residual risks.

7. Commit and open PR:
   - Commit verified changes and push the branch.
   - Read [references/pr-babysitting.md](references/pr-babysitting.md).
   - Open a full non-draft PR with fp issue ID, summary, verification, review passes, and warnings.
   - Set `symphony_pr_url`, `symphony_pr_number`, and `symphony_head_sha`.

8. Babysit PR:
   - Loop on checks, mergeability, review feedback, and review-bot feedback.
   - Fix deterministic failures, rerun relevant verification, commit, push, and continue.
   - Stop only when success criteria are met or a human decision is required.

## Finish

Only mark the issue done after implementation, verification, review passes, PR
creation, required fp properties, and babysitting are complete. If blocked, leave
the issue open and comment with the exact blocker, evidence collected, and next
human decision needed.
