# Daytona snapshot — `symphony-codex-bun`

The orchestrator dispatches workers into Daytona sandboxes built from the
`symphony-codex-bun` snapshot (referenced by name in `WORKFLOW.md`). This
directory holds the Dockerfile, the build/register script, and the docs
needed to provision that snapshot against a local Daytona OSS install.

For the integration **test stack** snapshot (`symphony-test-codex`, used only
by the orchestrator's `test:daytona:*` adapter and session tests), see
`../test/daytona/Dockerfile.snapshot` instead.

## What's inside

| Tool                                                                     | Why it ships in the snapshot                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `git`, `bash`, `curl`, `jq`, `ripgrep`, `procps`, `sudo`, `tar`, `unzip` | Shell + repo hygiene basics.                                                                                                         |
| `node 20` + `@openai/codex@0.128.0`                                      | Worker runtime (`codex app-server`) — pinned per `scripts/codex-ts-codegen.ts:REQUIRED_CODEX_VERSION`.                               |
| `bun`                                                                    | Worker invokes `bun run test`, `bun run format:check`, `bun run check`.                                                              |
| `drift`                                                                  | Worker invokes `bun run lint:drift`. Installed from the project's release tarball at `https://github.com/fiberplane/drift/releases`. |
| `@ast-grep/cli`                                                          | Used transitively by `bun run lint:ast` via `bun run check`.                                                                         |

The non-root `daytona` user matches Daytona's runtime convention. Workspace
mounts at `/workspace` per `WorkflowConfig.sandbox.repoPath`.

## Build + register against your local Daytona

Prerequisites:

- Local Daytona OSS stack reachable at `http://localhost:3000` (see
  `SWYRD-ktawnoxl` for setup notes once that ticket lands).
- A dashboard-issued admin API key.

From the repo root:

```bash
DAYTONA_API_KEY=<paste-local-daytona-api-key> \
  bun run --filter @switchyard/symphony-orchestrator snapshot:build
```

The script (`build.ts`) is idempotent: if `symphony-codex-bun` already exists
and is `active`, it exits 0. Otherwise it submits the build, polls every 3 s,
and exits when the snapshot reaches `active` or `build_failed` (15 min
ceiling). Build time is dominated by apt + npm + bun installer steps —
expect 3–6 minutes on a warm Docker engine.

### Targeting a non-default Daytona

All env vars are optional except `DAYTONA_API_KEY`:

| Env                   | Default                                 |
| --------------------- | --------------------------------------- |
| `DAYTONA_API_URL`     | `http://localhost:3000/api`             |
| `DAYTONA_TARGET`      | `us`                                    |
| `DAYTONA_SNAPSHOT`    | `symphony-codex-bun`                    |
| `DOCKERFILE`          | `./Dockerfile` (relative to `build.ts`) |
| `SNAPSHOT_TIMEOUT_MS` | `900000` (15min)                        |

## Verifying the snapshot

After the build, list snapshots and confirm `state=active`:

```bash
curl -s -H "Authorization: Bearer $DAYTONA_API_KEY" \
  http://localhost:3000/api/snapshots | jq '.items[] | {name, state}'
```

A targeted sanity-check against the snapshot's tooling: create a one-off
sandbox via the dashboard and run `git --version && bun --version && drift --version && codex --version`. All four should print versions cleanly.

## Iterating on the Dockerfile

Snapshots are addressed by name. Re-running the build script after editing
the Dockerfile keeps the `symphony-codex-bun` name and replaces the active
image once the new build completes. Existing in-flight sandboxes keep
running on the older image; new sandboxes pick up the new one.

If you want to keep the old snapshot around for forensic comparison, rename
it first via the dashboard or push the new build under a different
`DAYTONA_SNAPSHOT` value before swapping `WORKFLOW.md`.

## Troubleshooting

| Symptom                                          | Diagnosis / fix                                                                                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 Forbidden` on `POST /api/snapshots`         | The API key lacks `write:snapshots`. Create a new key in the dashboard with that permission (and `delete:snapshots` if you want the script to auto-replace failed snapshots).                                                      |
| `Snapshot ... build_failed: <reason>`            | The build script auto-deletes a `build_failed` snapshot on the next run, so re-running with the same env is the recovery path. To inspect the build logs, hit `GET /api/snapshots/:id/build-logs` while the snapshot still exists. |
| `Snapshot did not become active within 900000ms` | Bump `SNAPSHOT_TIMEOUT_MS` (the apt + npm + bun installer chain can be slow on cold caches). Confirm the runner isn't blocked on a stalled `PULL_SNAPSHOT` job via the dashboard.                                                  |
| `Cannot find module '@daytona/sdk'`              | Run `bun install` at the repo root — `@daytona/sdk` is a workspace dep declared by `apps/symphony-orchestrator/package.json`.                                                                                                      |
