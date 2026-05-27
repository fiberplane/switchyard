# Remote Daytona Env

## Goal

Configure the gitignored orchestrator env file for Daytona Cloud, GitHub, fp REST, and Codex auth.

## Required File

Create `apps/symphony-orchestrator/.env` from `.env.example`. The file is gitignored and must not
be committed.

Required values for the full E2E:

```bash
SWITCHYARD_REMOTE_DAYTONA_E2E=1
DAYTONA_API_KEY=<daytona-cloud-api-key>
DAYTONA_SNAPSHOT=<active-cloud-snapshot>
GITHUB_TOKEN=<repo-scoped-token>
FP_REMOTE=rest-api
FP_TOKEN=<fp-token>
FP_SERVER_URL=<fp-server-url>
FP_WORKSPACE=<fp-workspace>
FP_PROJECT_ID=<fp-project-id>
SWITCHYARD_CODEX_AUTH=/absolute/path/to/auth.json
```

If the required REST-capable `fp` binary is not the first `fp` on `PATH`, also set:

```bash
SWITCHYARD_FP_BIN=/absolute/path/to/fp
```

Optional controls:

```bash
SWITCHYARD_REMOTE_DAYTONA_BASE_BRANCH=<branch>
SWITCHYARD_REMOTE_DAYTONA_ALLOWED_BRANCH_PREFIX=symphony/e2e/
SWITCHYARD_REMOTE_DAYTONA_KEEP=1
SWITCHYARD_REMOTE_DAYTONA_TEST_RUN_ID=<uuid>
```

## Verification

Run the token preflight before the full E2E:

```bash
bun run --filter @switchyard/qa github-token:preflight
```

Then run the gated scenario:

```bash
bun run --filter @switchyard/qa remote-daytona:e2e
```
