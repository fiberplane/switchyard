# FP REST From A Daytona Sandbox

Use REST mode from a directory outside the repo checkout so fp does not resolve
local `.fp` project state. This is required for Switchyard remote Daytona runs.

## Environment

Required for env-only no-clone REST mode:

- `FP_REMOTE=rest-api`
- `FP_TOKEN`
- `FP_WORKSPACE`
- `FP_PROJECT_ID`
- `FP_SERVER_URL`

Optional:

- `FP_PROJECT_PREFIX`

Never print token values. Non-secret checks are fine, for example:

```bash
env | rg '^FP_(REMOTE|WORKSPACE|PROJECT_ID|PROJECT_PREFIX|SERVER_URL)='
```

## Workdir

Run REST fp commands from the orchestrator-provided non-repo workdir:

```bash
mkdir -p /tmp/.symphony/fp-rest
cd /tmp/.symphony/fp-rest
```

Use the global `fp` binary, not a repo-local wrapper.

## Read Context

Fetch every target issue and comments before editing code:

```bash
FP_REMOTE=rest-api fp issue get "$ISSUE_ID" --format json
FP_REMOTE=rest-api fp comment list "$ISSUE_ID" --format json
```

Fetch the parent, siblings, dependencies, and any docs or proposal links called
out by the issue. If an ID is ambiguous, search in REST mode instead of guessing.

## Update Issue State

Post clear progress comments at state transitions:

```bash
FP_REMOTE=rest-api fp issue update "$ISSUE_ID" --status in-progress
FP_REMOTE=rest-api fp comment "$ISSUE_ID" "Started in Daytona sandbox $SYMPHONY_SANDBOX_ID on branch $SYMPHONY_BRANCH."
```

Use comments for narrative updates and `fp issue update` for status or metadata
changes. Do not mark done until the finish criteria in `SKILL.md` are met.

## Custom Properties

Set canonical Switchyard properties as values become available:

```bash
FP_REMOTE=rest-api fp issue update "$ISSUE_ID" \
  --property symphony_branch="$SYMPHONY_BRANCH" \
  --property symphony_base_sha="$SYMPHONY_BASE_SHA" \
  --property symphony_run_id="$SYMPHONY_RUN_ID" \
  --property symphony_sandbox_id="$SYMPHONY_SANDBOX_ID"
```

After PR creation:

```bash
FP_REMOTE=rest-api fp issue update "$ISSUE_ID" \
  --property symphony_pr_url="$PR_URL" \
  --property symphony_pr_number="$PR_NUMBER" \
  --property symphony_head_sha="$HEAD_SHA"
```

If the installed `fp` cannot set custom properties in REST no-clone mode, comment
the exact failure without printing secrets and continue with PR creation. Do not
write `symphony_artifact`.

## Evidence Attachments

For screenshots, logs, or other visual evidence:

```bash
FP_REMOTE=rest-api fp attach /path/to/evidence.png
FP_REMOTE=rest-api fp comment "$ISSUE_ID" --file /tmp/evidence-comment.md
```

`fp attach` prints a markdown reference using `fp-asset://...`. Include that
markdown in issue comments and PR bodies. Do not commit gitignored evidence
unless explicitly asked.

## Blockers

If REST fp fails, verify only non-secret environment and command shape. Report
missing or invalid context without printing `FP_TOKEN`.
