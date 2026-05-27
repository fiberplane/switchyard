# Symphony Dashboard Brief

This brief describes the current remote Daytona orchestration path. Historical
local Daytona, archive upload, and host-side bundle integration notes belong in
`docs/graveyard/`.

## Runtime Story

1. The orchestrator selects one eligible fp issue.
2. It creates a remote Daytona sandbox from the configured snapshot.
3. It resolves the GitHub base branch SHA and asks the sandbox to clone the
   repository at that pinned base.
4. It uploads only the worker prompt, Codex auth, and the one-shot worker env
   bridge outside the cloned repository.
5. The worker owns durable state after handoff: it pushes its branch, opens a
   non-draft GitHub PR, updates canonical fp `symphony_*` fields, comments
   verification evidence, and marks the issue done.
6. The orchestrator stores local transcript/run evidence and verifies the fp PR
   metadata after the worker turn closes.

## Primary Links

| Surface | Purpose |
| --- | --- |
| fp issue | Queue state, run metadata, verification comments |
| Daytona sandbox id | Cloud runtime identity for logs and inspection |
| GitHub branch | Worker-owned code state |
| GitHub PR | Human review artifact and check surface |
| `.symphony/runs/<issue>/<attempt>/transcript.jsonl` | Redacted local transcript evidence |
| `.symphony/runs/<issue>/<attempt>/outcome-record.json` | Orchestrator verification record |

## Canonical fp Properties

| Property | Source | Meaning |
| --- | --- | --- |
| `symphony_state` | orchestrator and worker | `active`, `needs-attention`, or `end` |
| `symphony_attempt` | orchestrator | Attempt number |
| `symphony_last_error` | orchestrator or worker | Bounded failure head |
| `symphony_branch` | orchestrator then worker | Deterministic worker branch |
| `symphony_pr_url` | worker | Reviewable PR URL |
| `symphony_pr_number` | worker | PR number as text |
| `symphony_base_sha` | orchestrator then worker | Pinned remote base SHA |
| `symphony_head_sha` | worker | Pushed branch head SHA |
| `symphony_run_id` | orchestrator then worker | Switchyard run identifier |
| `symphony_sandbox_id` | orchestrator then worker | Daytona sandbox id |

`symphony_artifact` is retired and rejected by the fp property decoder.

## State Model

| State | Dashboard Meaning |
| --- | --- |
| `todo` + `symphony_ready=true` | Candidate for dispatch |
| `in-progress` + `symphony_state=active` | Orchestrator or sandbox worker is running |
| `todo` + `symphony_state=needs-attention` | Human needs to inspect failure and re-arm |
| `done` + `symphony_state=end` | Worker finished, PR metadata verified |

## Useful Dashboard Columns

Show these fields together:

- fp display id, title, assignee, and status
- `symphony_state`, `symphony_attempt`, and `symphony_last_error`
- `symphony_run_id` and `symphony_sandbox_id`
- `symphony_branch`, `symphony_pr_url`, and `symphony_head_sha`
- last orchestrator event time and latest fp comment summary

## Failure Classes

| Class | Typical Evidence |
| --- | --- |
| Pre-claim dispatch failure | Orchestrator logs only; issue remains re-dispatchable |
| Sandbox create/setup/upload/session failure | `symphony_last_error`, transcript if available |
| Protocol failure | Redacted transcript plus fp terminal-state check |
| Worker handoff incomplete | Local outcome record names missing fp metadata |
| Worker-owned failure | fp comments/properties and the PR state |

## E2E Confidence Signal

The strongest dashboard-ready acceptance signal is a remote E2E run that proves:

- Daytona sandbox creation succeeds with the configured snapshot.
- GitHub branch creation/deletion preflight succeeds with the configured token.
- fp REST no-clone metadata can be read and written.
- The worker opens a PR and writes the canonical fp properties.
- The orchestrator verifies fp metadata and records the sandbox id plus run id.
- Secret scanning finds no configured tokens in transcripts, evidence files,
  PR body/comments, fp comments, or git remotes.
