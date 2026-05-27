# Orchestrator runOne — Remote Daytona Lifecycle

Status: Active. Scope: `apps/symphony-orchestrator/src/orchestrator/service.ts`.

`runOne(issue)` is the per-issue remote Daytona driver. It selects no work by itself; the
tick loop and selector hand it one eligible fp issue. The active source strategy is
GitHub clone and the active artifact strategy is GitHub PR. The retired local archive and
host-side bundle path is documented in `docs/graveyard/`.

## Pipeline

```
HOST                                                       SANDBOX
─────────────────────────────────────────────────────────  ──────────────────────────────
1. parse symphony_attempt + compute attempt/run id          n/a
2. prepare GithubCloneSourceHandoff                         n/a
   - validate repo URL and branch
   - resolve base SHA with git ls-remote
   - compute deterministic worker branch
3. verify host Codex auth file exists                       n/a
4. enter scoped post-claim lifecycle                        n/a
   - register running-set release finalizer
   - claim running set
   - fp.claimIssue + fp.setAttempt
5. daytona.createSandbox(snapshot, labels, CODEX_HOME)      sandbox boots
   - register sandbox secret cleanup finalizer
   - fp.setRunMetadata(branch/base/run/sandbox)
6. render worker prompt and worker env bridge               n/a
7. sandboxScripts.setupClone                                clone repo, checkout base SHA,
                                                            create branch, write source.json
8. upload prompt, Codex auth, and worker env bridge          files land outside repo
9. start codex app-server with worker env sourced once       Codex runs in cloned repo
10. runner.runTurn(prompt, cwd, timeout)                    worker edits, verifies, pushes PR
11. close codex session child scope                          process/session closed
12. write redacted transcript                                local evidence
13. verify worker-owned fp metadata                          read fp issue state
14. write local outcome-record                               local evidence
15. release running-set finalizer                            slot frees
16. cleanup sandbox secret files                             best-effort remote cleanup
```

The worker owns durable state after step 9. A completed worker turn is considered
locally integrated only when fp reads back:

- `status=done`
- `symphony_state=end`
- `symphony_branch`
- `symphony_pr_url`
- `symphony_pr_number`
- `symphony_base_sha`
- `symphony_head_sha`
- `symphony_run_id`
- `symphony_sandbox_id`

`symphony_branch`, `symphony_base_sha`, `symphony_run_id`, and `symphony_sandbox_id`
must match the orchestrator handoff. Missing or mismatched metadata records a local
`needs-attention` outcome. If fp is still non-terminal, the orchestrator also parks the
issue at `symphony_state=needs-attention`; if the worker already wrote terminal state, the
orchestrator preserves it.

## Secret Handling

The orchestrator never renders tokens into prompts or shell command arguments.

- Host `.env` values are decoded into runtime config and stay gitignored.
- GitHub clone setup uses temporary `GIT_ASKPASS` behavior instead of credentialed remotes.
- Worker fp/GitHub credentials are uploaded in `/tmp/.symphony/worker-env`, sourced once by
  the app-server wrapper, and removed before Codex starts working.
- Codex auth is uploaded to `/tmp/.symphony/codex-home/auth.json`; `CODEX_HOME` points there.
- A scope finalizer removes `/tmp/.symphony/worker-env`,
  `/tmp/.symphony/codex-home/auth.json`, and the empty Codex home directory.
- If that remote cleanup fails, the finalizer logs `sandbox.secret-cleanup.failed` and adds
  a sanitized fp comment so operators know to inspect the retained sandbox.
- Transcript redaction includes configured fp/GitHub tokens and string secrets found inside
  the copied Codex auth JSON.

## Failure Routing

| Failure | Claimed? | Result |
| --- | --- | --- |
| source handoff preparation | no | log and skip candidate |
| missing host Codex auth | no | log and skip candidate |
| running-set duplicate | no fp claim | skip candidate |
| sandbox create/setup/upload/session start | yes | local record plus `markNeedsAttention` |
| runner returns non-completed turn | yes | local record plus conditional fp park |
| transcript/outcome-record write after worker terminal state | yes | local record; skip fp park if worker already wrote terminal state |
| intermediate fp write failure | yes | log, return needs-attention result, release slot |
| SIGINT/SIGTERM | yes | interrupt fiber; finalizers release slot and cleanup |

For post-handoff failures, the orchestrator checks whether the worker has already written
terminal fp state (`done`, `symphony_state=end`, or `symphony_state=needs-attention`) before
parking the issue. If the worker owns terminal state, the orchestrator preserves it.

## Invariants

- Source handoff and host auth checks happen before the fp claim.
- The running-set release finalizer is registered before the fp claim write.
- Prompt rendering happens after sandbox creation because the prompt includes sandbox id.
- The Codex session is scoped separately from post-turn verification.
- Secret-bearing uploads happen after clone setup succeeds.
- The app-server command sources the worker env once and deletes it before worker commands run.
- The active runtime does not upload source archives, finalize bundles, download worker
  outcome artifacts, integrate host branches, or write `symphony_artifact`.

## Operator Evidence

Each run leaves:

- A redacted transcript under `.symphony/runs/<issue-id>/<attempt>/transcript.jsonl`.
- An `outcome-record.json` containing the orchestrator's local integrated or
  needs-attention result.
- fp properties containing run id, sandbox id, branch, PR, base SHA, and head SHA when
  the worker completed the PR workflow.
- Daytona labels with `fp_issue_id`, `fp_display_id`, `attempt`, `run_id`, and app/source
  labels for cleanup and dashboard grouping.
