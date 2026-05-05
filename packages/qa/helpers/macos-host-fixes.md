# macOS Host Fixes

## Goal

Apply the macOS-specific DNS workaround that the local Daytona test stack needs. Without it,
every sandbox-side operation that uses `*.proxy.localhost` URLs (uploads, command execution,
downloads) fails at the transport boundary.

## Status

**Upstreamed into the test stack as of `SWYRD-snbircyn` (done).** The compose wrapper at
`apps/symphony-orchestrator/test/daytona/compose.sh` auto-applies
`compose.test.macos.yaml` when `uname` is `Darwin`. You should not need to do anything manual.

This helper is kept around as a footnote in case the workaround ever stops working — see the
**Validating the resolver path** section below.

## What the workaround does

The upstream Daytona compose hard-codes `proxy.localhost` in `PROXY_DOMAIN` and
`PROXY_TEMPLATE_URL`. The Daytona SDK constructs `<port>-<sandboxId>.proxy.localhost` URLs for
every post-create sandbox interaction.

- **Linux** resolves `*.localhost` → `127.0.0.1` automatically (glibc / systemd, per RFC 6761).
- **macOS** does not — only bare `localhost` is special-cased. `*.localhost` returns
  `ENOTFOUND` from `getaddrinfo`, which is what `node:dns`, `Bun.dns`, and the Daytona SDK
  (axios) all use.

The overlay (`compose.test.macos.yaml`) swaps the env vars to use
`*.proxy.127.0.0.1.nip.io` instead. `nip.io` is a public wildcard DNS service that resolves
`*.<ip>.nip.io` → the embedded IP. macOS resolves it via the normal system resolver.

## Validating the resolver path (forensics)

If `bun run test:daytona:up` succeeds but scenarios still fail with `ECONNREFUSED` /
`ENOTFOUND` against sandbox URLs, the nip.io path is the first thing to check. Use the
**system** resolver (the one `getaddrinfo` consults — `dig @8.8.8.8` only tests the public path
and would skip whatever stage actually fails):

```
host anything.proxy.127.0.0.1.nip.io
# Expected: anything.proxy.127.0.0.1.nip.io has address 127.0.0.1
```

If that fails, your DNS resolver is the suspect, not the test stack. Diagnose via
`/etc/resolver/`, mDNSResponder cache flush (`sudo dscacheutil -flushcache; sudo killall -HUP
mDNSResponder`), or testing against a different resolver.

To confirm the overlay actually merged into the running compose:

```
apps/symphony-orchestrator/test/daytona/compose.sh config | grep -E "PROXY_(DOMAIN|TEMPLATE_URL)"
```

Expected on macOS:

```
PROXY_DOMAIN: proxy.127.0.0.1.nip.io:34000
PROXY_TEMPLATE_URL: http://{{PORT}}-{{sandboxId}}.proxy.127.0.0.1.nip.io:34000
```

## Trade-offs (informational)

- **Third-party DNS dep.** nip.io has been stable for years but is a runtime dependency for
  local dev on macOS. Cold DNS cache + no network = stack fails. Self-hosting the wildcard
  zone (e.g., a dnsmasq sidecar) is a follow-up if it ever bites — `SWYRD-ncmoqakn` tracks the
  upstream Bun follow-up for the underlying `dns.lookup` issue.
- **Linux unaffected.** The overlay is macOS-only. CI and Linux dev keep using
  `proxy.localhost` exactly as before.

## Related

- `apps/symphony-orchestrator/test/daytona/README.md#macos-dns-workaround` — full background.
- `SWYRD-snbircyn` — the spike + workaround landing.
- `SWYRD-ncmoqakn` — upstream Bun `dns.lookup` follow-up (out of scope for v1).

## Cleanup

Nothing to clean — the workaround lives in compose YAML, not host config.
