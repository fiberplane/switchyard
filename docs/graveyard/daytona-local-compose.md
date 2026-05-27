# Retired Daytona Local Compose

This document preserves the removed Daytona OSS/docker-compose implementation. It no longer
describes the active Switchyard sandbox path: remote runs now use Daytona Cloud through
`apps/symphony-orchestrator/.env`, and the validated E2E evidence is committed under
`packages/qa/results/remote-daytona-e2e-4797077e-55fc-42c7-8152-bbddc9bbc1bc.md`.

## Retirement Rationale

The local compose stack was retired after the remote Daytona Cloud E2E path proved the full
fp -> Daytona Cloud -> GitHub PR -> fp terminal metadata loop. Keeping the local stack active made
normal verification depend on Docker or OrbStack, large image pulls, local DNS behavior, local
dashboard state, and several repair steps unrelated to the intended production architecture.

Remote Daytona now gives the orchestrator one sandbox strategy:

- host-only Daytona API credentials
- a Cloud snapshot selected by host env/workflow config
- GitHub clone source handoff from a pinned base SHA
- worker-owned branch, PR, and fp completion
- cleanup by labels, PR head branch, and test run id

## Removed Paths

The production local stack lived at:

- `apps/symphony-orchestrator/daytona/`
- `apps/symphony-orchestrator/daytona/compose.yaml`
- `apps/symphony-orchestrator/daytona/compose.sh`
- `apps/symphony-orchestrator/daytona/dex/`
- `apps/symphony-orchestrator/daytona/otel/`
- `apps/symphony-orchestrator/daytona/pgadmin4/`

The compose-backed test stack lived at:

- `apps/symphony-orchestrator/test/daytona/compose.test.yaml`
- `apps/symphony-orchestrator/test/daytona/compose.test.macos.yaml`
- `apps/symphony-orchestrator/test/daytona/compose.sh`
- `apps/symphony-orchestrator/test/daytona/Dockerfile.snapshot`
- `apps/symphony-orchestrator/test/daytona/runner-daemon.json`
- `apps/symphony-orchestrator/test/daytona/warm.ts`
- `apps/symphony-orchestrator/test/daytona/dex/`
- `apps/symphony-orchestrator/test/daytona/otel/`
- `apps/symphony-orchestrator/test/daytona/pgadmin4/`
- local helpers such as `stack.ts`, `snapshot.ts`, and `repair-runner-scheduling.ts`

Package scripts removed with those paths:

- `daytona:up`
- `daytona:down`
- `test:daytona:up`
- `test:daytona:down`

## Upstream Pin

Both local stacks were vendored from `daytonaio/daytona`'s upstream Docker compose at commit
`8b7331b`. The production stack and test stack intentionally stayed on the same upstream pin so
runtime behavior did not drift between manual dogfood and adapter/session tests.

## Production/Test Stack Split

The repo had two distinct local compose stacks:

| Concern | Production local stack | Test local stack |
| --- | --- | --- |
| Former path | `apps/symphony-orchestrator/daytona/` | `apps/symphony-orchestrator/test/daytona/` |
| Compose project | `switchyard-daytona` / historical `daytona` | `switchyard-test` |
| Former usage | manual dogfood and orchestrator dispatch | adapter/session integration tests |
| API port | `3000` | `33000` |
| Proxy port | `4000` | `34000` |
| Dex port | `5556` | `35556` |
| pgAdmin port | `5050` | `35050` |
| Registry port | `6000` | `36000` |
| SSH gateway | `2222` | `32222`, remapped to `32223` by the macOS overlay |
| Snapshot | `symphony-codex-bun` | `symphony-test-codex` |
| API key | dashboard-created key | hard-coded `switchyard-test-api-key` |

They could run side by side because host ports and compose project names differed.

## macOS Proxy Workaround

Upstream Daytona compose used `proxy.localhost` in `PROXY_DOMAIN` and
`PROXY_TEMPLATE_URL`. Linux resolved wildcard localhost names, but macOS only special-cased bare
`localhost`, so URLs such as `<port>-<sandboxId>.proxy.localhost` failed with `ENOTFOUND`.

Switchyard patched both stacks to use `proxy.127.0.0.1.nip.io`. The public `nip.io` wildcard DNS
service resolved names containing `127.0.0.1` back to loopback without host resolver edits. The
test stack applied this with `compose.test.macos.yaml`; the production stack baked the same idea
into its vendored compose file.

If upstream proxy settings changed while Redis still held old sandbox toolbox URLs, newly-created
sandboxes could keep stale `toolboxProxyUrl` values until cache expiry. The historical workaround
was to flush the local Redis container.

## Dashboard Credentials And API Keys

The local dashboard used upstream dev Dex defaults:

- email: `dev@daytona.io`
- password: `password`

The onboarding key was read-scoped. Snapshot creation required a fresh dashboard API key with
`write:snapshots`; the snapshot replacement path also needed `delete:snapshots`.

The test stack instead exposed a hard-coded admin key:

- `ADMIN_API_KEY=switchyard-test-api-key`

That key was intended only for disposable local test compose.

## Snapshot Gotchas

The production stack used `symphony-codex-bun`, built by `snapshot:build`. First build was slow
because it installed system packages, Bun, Codex, fp, drift, ast-grep, and related tooling. The
test stack used `symphony-test-codex`, a smaller Ubuntu image from `Dockerfile.snapshot`.

The first sandbox creation after snapshot build paid an additional local runner cost while the
runner pulled, retagged, and pushed the snapshot through its local registry. Warm runs were much
faster.

## Runner Scheduling Repair

Local OSS runner rows could become stale and report no available runners. The removed helper
`repair-runner-scheduling.ts` patched the compose database when
`SWITCHYARD_DAYTONA_REPAIR_RUNNER=1` by setting the default runner availability score and disk
usage fields back to schedulable values. This was never part of the Cloud path.

## Historical Test Behavior

The old `adapter.test.ts` and `session.test.ts` files exercised real sandbox lifecycle,
upload/download, command execution, and bidirectional session streaming against the local test
compose stack. They were slow, Docker-dependent, and failed whenever the local stack was down.

The active replacement is split:

- cheap unit tests remain for schema/error/service construction behavior
- remote-gated Cloud smoke remains in `remote-cloud.test.ts`
- full proof is the `packages/qa` remote Daytona E2E, gated by
  `SWITCHYARD_REMOTE_DAYTONA_E2E=1`

## What Not To Restore

Do not reintroduce active docs or package scripts that ask operators to boot local Daytona
compose. If local OSS Daytona is useful for a future experiment, add it under a new proposal or
experiment and keep it separate from the orchestrator's supported sandbox strategy.
