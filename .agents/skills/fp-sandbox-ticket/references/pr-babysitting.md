# PR Creation And Babysitting

Use this when opening a PR, continuing an existing PR, or checking whether the
branch is ready for human review or merge.

## Identify Or Create The PR

```bash
gh pr view --json number,url,headRefName,baseRefName,state,mergeStateStatus,reviewDecision,statusCheckRollup
```

If no PR exists, push the branch and create a full non-draft PR unless the user
explicitly asked for a draft:

```bash
git push -u origin "$BRANCH_NAME"
gh pr create --base main --head "$BRANCH_NAME" --title "$TITLE" --body-file /tmp/pr-body.md
```

Keep authentication token-isolated:

- `gh` uses `GH_TOKEN` or `GITHUB_TOKEN` from process environment.
- `git push` and `git fetch` use `GIT_ASKPASS`.
- Do not run `gh auth login` unless you create a temporary `GH_CONFIG_DIR` and remove it before diagnostics.
- Do not put tokens in clone URLs, git remotes, command text, artifacts, fp comments, or PR text.

The PR body must include fp issue IDs, summary, verification, review passes,
evidence links when relevant, and known warnings or handoff reasons.

## Initial Review Sweep

Fetch current PR state before waiting:

```bash
gh pr view --json mergeStateStatus,reviewDecision,updatedAt,headRefOid,statusCheckRollup
gh pr checks
```

Handle feedback by priority:

- Fix high-priority or changes-requested feedback without prompting when the fix is clear.
- Fix medium-priority actionable feedback when it is correct and scoped.
- Ask before spending time on low-priority nits or stylistic preferences.
- Skip resolved threads and purely informational bot comments.
- Treat review-bot findings as real hypotheses until verified.

## Waiting For Checks

Do not treat zero checks as success. GitHub can take 10-30 seconds after a push
before checks register.

Use conservative polling:

```bash
gh pr checks --watch
```

If `--watch` is unavailable or too noisy, poll every 60-120 seconds and emit only
state changes. Required checks block success. If no checks are registered after a
reasonable wait, record that clearly rather than calling it green.

## Fixing CI Failures

Investigation is mandatory before any fix:

1. Inspect every failed, skipped, cancelled, or otherwise non-pass gated result.
2. Read full logs, using `gh run view <run-id> --log-failed` when needed.
3. Trace from the failing assertion, exception, or lint rule into source and tests.
4. State the cause clearly before editing.
5. Apply a minimal root-cause fix, rerun local verification, commit, push, and continue.

## Mergeability

Before declaring success:

```bash
gh pr view --json mergeStateStatus,baseRefName,headRefName,reviewDecision,statusCheckRollup
```

If the PR is behind, dirty, blocked, or otherwise not mergeable, update the
branch only when the risk is clear. Ask for help when rebasing/merging requires
product judgment.

## Exit Conditions

Success means checks are passing or explicitly non-applicable, mergeability is
clean, review feedback has no unhandled high/medium/review-bot findings, fp
properties are set, and the issue/PR both contain verification evidence. Stop
early only after leaving a clear fp issue comment and PR note with the blocker,
evidence collected, and the next human decision needed.
