# Implementation, Verification, And Evidence

## Before Editing

Read `AGENTS.md`, relevant docs, and nearby tests. Confirm whether the issue is
code, docs, test harness, workflow, or release-affecting work.

Create or reset the orchestrator-provided branch from the pinned base SHA:

```bash
git fetch --no-tags origin "$SYMPHONY_BASE_SHA"
git switch -C "$SYMPHONY_BRANCH" "$SYMPHONY_BASE_SHA"
```

Keep `origin` credential-free. Git auth should flow through `GIT_ASKPASS` and
`GITHUB_TOKEN`, not through remote URLs.

## Implementation

- Keep changes scoped to the fp issue and acceptance criteria.
- Prefer established repo patterns and package scripts.
- Use `bun` scripts from `package.json`; do not use `npx`.
- For generated scripts, use checked-in helpers, explicit temp files, `node`, or `bun -e`.
- Prefer exact block replacement, parsers, or AST-aware transforms over brittle line deletion.
- Add or update tests proportional to risk and blast radius.
- Use drift when docs describe code behavior.

## Local Verification

Run narrow checks first, then broaden:

- Changed a unit with tests: run that test file or package test.
- Changed shared contracts: run package typecheck and affected tests.
- Changed repo-wide behavior: run `bun run test`, `bun run format:check`, and `bun run check`.
- Changed remote Daytona behavior: run the configured E2E scenario when credentials are present.

Record exact verification commands and results in fp and the PR. If the sandbox
cannot launch Docker, a browser, or a service, record the degraded verification.

## Review Passes

Before opening or finalizing the PR:

1. Review your own diff for correctness, security, test risk, and unrelated changes.
2. Use strict review skills or subagents when available.
3. Treat findings as hypotheses: verify each, fix true positives, and record material false positives.
4. Re-run relevant verification after substantial fixes.

## Evidence

Save local evidence outside the repo unless the issue explicitly asks for a
checked-in scenario or artifact. Upload visual evidence through fp REST
attachments and include the resulting markdown in fp comments and the PR body.
