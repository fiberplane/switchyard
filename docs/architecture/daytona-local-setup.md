# Daytona local setup

The orchestrator dispatches workers into a local Daytona OSS install. The
compose stack is **vendored in-repo** at `apps/symphony-orchestrator/daytona/`
(distinct from the minimal test stack at `apps/symphony-orchestrator/test/daytona/`).
You do not need to clone Daytona OSS separately.

This page is the entry index for getting that stack running. The detailed
flow lives in two existing READMEs:

- [`apps/symphony-orchestrator/daytona/README.md`](../../apps/symphony-orchestrator/daytona/README.md)
  — bring the stack up / down, dashboard auth, key provisioning.
- [`apps/symphony-orchestrator/snapshot/README.md`](../../apps/symphony-orchestrator/snapshot/README.md)
  — build the `symphony-codex-bun` snapshot the orchestrator dispatches into.

The top-level [`README.md`](../../README.md) §"Quickstart for demo
participants" stitches these into a single walk-through and is the canonical
entry for a new developer.

## Prerequisites

- Docker (or OrbStack on macOS).
- `bun` >= 1.3.13. `bunfig.toml` `pathIgnorePatterns` requires that version;
  older Bun silently ignores the key and tries to load ~1000 upstream
  reference test files.
- `codex` CLI >= 0.128.0. The pin lives in
  [`scripts/codex-ts-codegen.ts`](../../scripts/codex-ts-codegen.ts)
  (`REQUIRED_CODEX_VERSION`); that file is the source of truth.
- `~/.codex/auth.json` on the host (ChatGPT login auth, not
  `OPENAI_API_KEY`). The orchestrator copies this into each sandbox at
  `/workspace/codex-home/auth.json`; see
  [`docs/architecture/orchestrator-runone.md`](orchestrator-runone.md)
  §"v1 demo codex auth".

## Canonical flow (one-time per machine)

From the repo root:

```bash
bun install

# 1. Bring up the local Daytona stack (vendored in-repo).
bun run --filter @switchyard/symphony-orchestrator daytona:up

# 2. Open the dashboard, log in with the upstream dev defaults
#    (dev@daytona.io / password), and create an API key with
#    write:snapshots + delete:snapshots permissions.
open http://localhost:3000/dashboard

# 3. Build the symphony-codex-bun snapshot once.
DAYTONA_API_KEY=<your-key> \
  bun run --filter @switchyard/symphony-orchestrator snapshot:build

# 4. Paste the key into the repo-root WORKFLOW.md sandbox.apiKey field.
$EDITOR WORKFLOW.md
```

The two scripts are idempotent: `daytona:up` is a no-op against a healthy
stack, and `snapshot:build` early-exits if the snapshot is already `active`.

## Operational gotchas

These don't fit cleanly inside the per-script READMEs but are worth knowing.

- **Read-scoped onboarding key.** The dashboard's onboarding flow issues a
  read-scoped key that returns `403 Forbidden Access denied` from
  `POST /api/snapshots`. Always create a fresh key from
  **Dashboard → API Keys → New** with `write:snapshots`. Source:
  `references/daytona/apps/api/src/sandbox/controllers/snapshot.controller.ts`
  if you have Daytona cloned alongside.
- **Redis caches the proxy URL.** After editing `PROXY_DOMAIN` /
  `PROXY_TEMPLATE_URL` in the compose env, freshly-created sandboxes inherit
  the old `toolboxProxyUrl` until the runtime cache TTL expires. Force-flush:
  `docker exec daytona-redis-1 redis-cli FLUSHALL`. (Look for the
  `*_CACHE_TTL_S`-shaped env in the upstream `sandbox.service.ts` if you
  need the exact name; the value drifts upstream.)
- **`autoDeleteInterval: -1` keeps sandboxes alive.** The committed
  `WORKFLOW.md` value is intentional — sandboxes survive past the run for
  forensic SSH access. Prune via the dashboard, or by Daytona label
  `app=symphony` / `fp_issue_id=<internal-id>`.
- **Test stack and prod stack can coexist** because the test stack remaps
  every public port by `+30000` (API `33000`, proxy `34000`, etc.) and uses
  a different compose project name (`switchyard-test` vs `daytona`). Run
  whichever you need; bring both up only if you have host port headroom.
- **First sandbox creation pays a one-time cost** (~2.5 min wall-clock):
  the runner pulls the snapshot from the API into its local registry,
  retags, and pushes. Subsequent dispatches against the same snapshot are
  fast.
- **Hetzner / cloud-host first-boot.** Runner logs may show
  `connect: connection refused` to `api:3000` for ~5–10s while the API
  finishes booting. Benign; the runner re-polls and recovers.

## Cross-references

- [`apps/symphony-orchestrator/daytona/README.md`](../../apps/symphony-orchestrator/daytona/README.md)
- [`apps/symphony-orchestrator/snapshot/README.md`](../../apps/symphony-orchestrator/snapshot/README.md)
- [`apps/symphony-orchestrator/test/daytona/README.md`](../../apps/symphony-orchestrator/test/daytona/README.md)
  — minimal **test** stack.
- [`docs/architecture/orchestrator-runone.md`](orchestrator-runone.md) —
  runOne pipeline, three-comment cadence, codex auth file-copy.
