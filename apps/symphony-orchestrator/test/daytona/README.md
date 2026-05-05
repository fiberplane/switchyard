# Daytona Test Stack

Integration tests in this directory use a vendored Daytona OSS compose stack named
`switchyard-test`. Public ports are remapped by `+30000` from the upstream compose:
API `33000`, proxy `34000`, runner `33003`, SSH `32222`, Dex `35556`, pgAdmin
`35050`, and registry `36000`.

## Stack

Start or refresh the stack from `apps/symphony-orchestrator`:

```bash
bun run test:daytona:up
```

Tear it down and reclaim volumes:

```bash
bun run test:daytona:down
```

The tests call `test:daytona:up` automatically and leave the stack running. The runner mounts
`runner-daemon.json` so sandbox containers use an inner Docker subnet that does not collide with
the compose network.

## Snapshot

`test-helpers/snapshot.ts` creates `symphony-test-base` on first use from
`Dockerfile.snapshot`. The image is Ubuntu 22.04 with bash, coreutils, curl, git, sudo, and tar,
running as the `daytona` user with a long-running entrypoint.

The inactive-state assertion uses a separate `symphony-test-inactive` snapshot so the shared base
snapshot stays active for sandbox lifecycle tests.

## Runner Repair

`test-helpers/repair-runner-scheduling.ts` contains the local OSS runner scheduling repair from
the smoke test. It is off by default and runs only when:

```bash
SWITCHYARD_DAYTONA_REPAIR_RUNNER=1 bun test --cwd apps/symphony-orchestrator test/daytona/adapter.test.ts
```

Use it if a fresh local stack reports `No available runners`. The test compose lowers scheduling
thresholds for normal runs, so this should only be needed for stale runner rows.
