# Local Daytona stack — `daytona`

The compose stack the orchestrator dispatches workers into. Vendored from
`daytonaio/daytona`'s upstream `docker-compose.yaml` at commit `8b7331b` —
same pin as the integration-test stack at `../test/daytona/compose.test.yaml`,
brought into this repo so the demo flow is self-contained (no need to clone
the upstream Daytona repo into `references/` first).

## Why a separate stack from `test/daytona/`?

Two stacks, two purposes:

|                  | `daytona/` (this dir)                                       | `test/daytona/`                                                 |
| ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Used by          | Orchestrator runtime, manual dogfood, demo runs.            | `bun test` integration tests for the Daytona adapter / session. |
| Project name     | `daytona`                                                   | `switchyard-test`                                               |
| API port         | `3000`                                                      | `33000`                                                         |
| Proxy port       | `4000`                                                      | `34000`                                                         |
| Default snapshot | `symphony-codex-bun` (full toolchain — see `../snapshot/`). | `symphony-test-base` (minimal).                                 |
| Auth             | Dashboard-issued API key (Dex login).                       | Hardcoded `ADMIN_API_KEY=switchyard-test-api-key`.              |

They bind different host ports and use different docker compose project names
so they can run side by side. Pick `daytona:up` when running the orchestrator
locally; `test:daytona:up` only when running the orchestrator's own test
suite.

## Bring up

```bash
bun run --filter @switchyard/symphony-orchestrator daytona:up

# Confirm the API answers 200
curl -sf http://localhost:3000/api/health   # → {"status":"ok"}

# Optional: dashboard sanity-check
open http://localhost:3000/dashboard
```

First-run image pull is multi-GB and takes several minutes. Subsequent
brings-up after a `down` are sub-30s with a warm Docker image cache.

## First-time setup after bring-up

The upstream stack does not seed an admin API key, so you have to provision
one once:

1. Open `http://localhost:3000/dashboard`.
2. Log in via Dex with the static dev creds: `dev@daytona.io` / `password`
   (these are the upstream-shipped dev defaults baked into `./dex/config.yaml`).
3. **From the API Keys panel, create a key with `write:snapshots` permission
   (and `delete:snapshots` so the snapshot build script can auto-replace
   failed builds).** The key issued during the onboarding flow is
   read-scoped and will fail at the snapshot-create step — see
   `SWYRD-ktawnoxl` for context.
4. Paste the key into the repo-root `WORKFLOW.md` `sandbox.apiKey` field.

Then build the production snapshot once:

```bash
DAYTONA_API_KEY=<paste-the-key> \
  bun run --filter @switchyard/symphony-orchestrator snapshot:build
```

(See `../snapshot/README.md` for the snapshot-build details.)

## Bring down

```bash
bun run --filter @switchyard/symphony-orchestrator daytona:down
```

This passes `down -v`, which removes volumes — your dashboard projects, API
keys, and any registered snapshots will be lost. Drop the `-v` if you want
to keep state across restarts (edit the script or invoke `compose.sh` with
custom args).

## macOS DNS background

The upstream compose hardcodes `proxy.localhost:4000` as the proxy URL the
Daytona SDK uses to reach a sandbox's toolbox. macOS does not resolve
`*.localhost` subdomains (only bare `localhost`), so on macOS hosts every
post-create sandbox call (`uploadFiles`, `executeCommand`, `downloadFiles`)
ENOTFOUNDs out. The vendored compose in this directory swaps the proxy URLs
to `proxy.127.0.0.1.nip.io:4000` — `nip.io` is a public wildcard DNS service
that resolves `*.<ip>.nip.io` to the embedded IP. No host-side resolver
setup, no per-developer `/etc/resolver/*` writes. Resolves on macOS and
Linux. The same trick is applied to the test stack via
`../test/daytona/compose.test.macos.yaml`.

If you bring up an existing pre-fix Daytona OSS install with the upstream
URLs, in-flight sandboxes keep the bad URL baked in. Recreate them after
patching the api env to pick up the new template.

## Ports exposed

| Service               | Host port |
| --------------------- | --------- |
| `api`                 | `3000`    |
| `proxy`               | `4000`    |
| `dex` (auth)          | `5556`    |
| `pgadmin`             | `5050`    |
| `registry`            | `6000`    |
| `registry-ui`         | `5100`    |
| `ssh-gateway`         | `2222`    |
| `maildev`             | `1080`    |
| `minio` (console)     | `9001`    |
| `jaeger` (tracing UI) | `16686`   |

Conflicts with these ports on your host will block the corresponding service
from binding. Common collision: a local sshd or devcontainer on `2222`. Stop
the conflicting process or remap the host side in `compose.yaml`.

## Troubleshooting

| Symptom                                        | Diagnosis / fix                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 Forbidden` on `POST /api/snapshots`       | API key lacks `write:snapshots`. Create a new key in the dashboard with that scope (see "First-time setup").                                              |
| `ECONNREFUSED` on sandbox upload/exec/download | Sandbox toolbox unreachable. With the vendored compose as-is, run `docker exec daytona-api-1 env` and confirm the `PROXY_DOMAIN` value contains `nip.io`. |
| `region_quota` or runner-availability errors   | Local dev DB needs nudges — same fixes as the test stack documents in `../test/daytona/README.md`.                                                        |

## Updating the vendor

When upstream Daytona changes the compose, refresh this copy from
`references/daytona/docker/docker-compose.yaml` (gitignored upstream clone)
and re-apply the proxy-URL swap. Keep the test-stack vendor and this one
pinned to the same upstream commit unless there's a reason to drift.
