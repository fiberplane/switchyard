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

Both scripts run through `compose.sh`, which auto-adds `compose.test.macos.yaml` on Darwin (see
[macOS DNS workaround](#macos-dns-workaround) below). On Linux the wrapper is a transparent
pass-through to `docker compose -p switchyard-test -f compose.test.yaml`.

## macOS DNS workaround

The upstream Daytona compose hard-codes `proxy.localhost` in the API's `PROXY_DOMAIN` and
`PROXY_TEMPLATE_URL` env vars. The Daytona SDK then constructs URLs of the form
`<port>-<sandboxId>.proxy.localhost` for every post-create sandbox interaction (uploadFiles,
executeCommand, downloadFiles).

**Linux** resolves `*.localhost` → 127.0.0.1 automatically (glibc / systemd, per RFC 6761), so the
upstream compose works as-is.

**macOS** does not — only bare `localhost` is special-cased. `*.localhost` returns ENOTFOUND from
`getaddrinfo`, which is what `node:dns`, `Bun.dns`, `ping`, and the Daytona SDK all use. Result:
without a workaround, every test that touches a sandbox after `createSandbox` fails at the
transport boundary.

The fix is a tiny compose overlay (`compose.test.macos.yaml`) that swaps the two affected env
vars to use `*.proxy.127.0.0.1.nip.io` instead:

```yaml
services:
  api:
    environment:
      PROXY_DOMAIN: proxy.127.0.0.1.nip.io:34000
      PROXY_TEMPLATE_URL: http://{{PORT}}-{{sandboxId}}.proxy.127.0.0.1.nip.io:34000
```

[`nip.io`](https://nip.io) is a public wildcard DNS service that resolves `*.<ip>.nip.io` to the
embedded IP. macOS resolves it via the normal system resolver, no host-side configuration needed.

The overlay is applied automatically by `compose.sh` when `uname` is `Darwin`. Linux users see no
behavior change — the overlay file is not even loaded.

### Validating the resolver path

If `bun run test:daytona:up` succeeds but tests still fail with `ECONNREFUSED` or `ENOTFOUND`, the
nip.io path is the first thing to check. Use the _system_ resolver (the one `getaddrinfo` consults
— `dig @8.8.8.8` would only test the public path and skip whatever stage actually fails):

```bash
host anything.proxy.127.0.0.1.nip.io
# Expected: anything.proxy.127.0.0.1.nip.io has address 127.0.0.1
```

If that fails, your DNS resolver is the suspect, not the test stack.

To confirm the overlay actually merged into the running compose, check the rendered config:

```bash
test/daytona/compose.sh config | grep -E "PROXY_(DOMAIN|TEMPLATE_URL)"
# Expected on macOS:
#   PROXY_DOMAIN: proxy.127.0.0.1.nip.io:34000
#   PROXY_TEMPLATE_URL: http://{{PORT}}-{{sandboxId}}.proxy.127.0.0.1.nip.io:34000
```

### Trade-offs

- **Third-party DNS dep.** nip.io has been stable for years but is a runtime dependency for local
  dev on macOS. If the host has a cold DNS cache and no network, the macOS test stack will not
  reach the proxy URL. Self-hosting the wildcard zone (e.g., a dnsmasq sidecar) is a follow-up if
  this ever bites.
- **Linux unaffected.** The overlay is macOS-only. CI on Linux (or any developer on Linux) keeps
  using `proxy.localhost` exactly as before.
- **Why not a `dns.lookup` shim in test bootstrap?** Because Bun's `node:http` / native `fetch`
  don't honor `node:dns.lookup` overrides — the SDK (axios) bypasses the patch. See `SWYRD-snbircyn`
  for the spike data and `SWYRD-ncmoqakn` for the upstream Bun follow-up.

## Snapshot

`test-helpers/snapshot.ts` creates `symphony-test-codex` on first use from
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

## Runtimes (known: this suite is slow)

These tests are **deliberately end-to-end against a real Daytona sandbox**, not mocks. Every test
that exercises `executeCommand` / `uploadFiles` / `downloadFiles` creates and tears down its own
sandbox. Sandbox creation alone takes ~15–25s (SDK roundtrip → runner job → container boot →
snapshot mount), so a 14-test file like `adapter.test.ts` runs for ~5 minutes wall time even on
a warm stack.

Bun runs _files_ in parallel, so the **total suite** is bounded by the slowest file, not the sum.
But within one file the per-test sandbox cost compounds linearly — that's the property of the
test pattern, not a tooling overhead.

If this becomes a daily-dev bottleneck, see SWYRD-qeuxjthv for tracked mitigation options
(snapshot reuse, intra-file parallelism, slow-test tagging). None implemented today; the slowness
is a feature of testing against a real sandbox boundary rather than a bug.
