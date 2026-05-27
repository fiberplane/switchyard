# Remote fp REST

## Goal

Verify the sandbox worker can use fp REST/no-clone mode to update the scratch issue without
cloning fp state into the repository.

## Required Env

`apps/symphony-orchestrator/.env` must include:

```bash
FP_REMOTE=rest-api
FP_TOKEN=<fp-token>
FP_SERVER_URL=<fp-server-url>
FP_WORKSPACE=<fp-workspace>
FP_PROJECT_ID=<fp-project-id>
```

The orchestrator passes the worker-safe fp REST configuration into the sandbox outside the repo.
The worker must set branch, PR, base SHA, head SHA, run id, sandbox id, `symphony_state=end`, and
`status=done` on the scratch issue.

## Verification

The E2E runner reads the scratch issue back after the worker turn and compares fp properties
against GitHub PR metadata and Daytona sandbox labels. A mismatch keeps the local run result out
of `integrated`.
