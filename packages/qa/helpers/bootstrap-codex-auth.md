# Bootstrap Codex Auth

## Goal

Get a working `~/.codex/auth.json` into the sandbox so `codex app-server` can authenticate when
the orchestrator spawns it. Without this step, the worker fails immediately at protocol init
and the scenario will never reach a turn.

## Background

Per spec `### Smoke Evidence` (lines 132-154 of
`docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md`), the local-demo auth path is:

- Copy **only** `~/.codex/auth.json` from the host into the sandbox under `CODEX_HOME`.
- Leave `OPENAI_API_KEY` and `SANDBOX_OPENAI_API_KEY` **unset** in the sandbox env.
- Result: `codex login status` reports `Logged in using ChatGPT`.

This is acceptable **only for throwaway local demos** because `auth.json` contains reusable
account auth material. Do not commit it; do not bake it into the snapshot; do not ship it
anywhere.

The mixed-auth gotcha: a placeholder `OPENAI_API_KEY` in env did NOT override the copied
ChatGPT auth on the 2026-05-04 smoke run. But running `codex login --with-api-key` in a
disposable mixed `CODEX_HOME` flipped `auth_mode` to `"apikey"`. So the rule is "ChatGPT auth
file alone, no API-key env vars, no API-key login commands."

## What needs to happen

1. Confirm the host has a valid `~/.codex/auth.json` (you've logged in to Codex CLI on the host
   at least once with a ChatGPT account, and `OPENAI_API_KEY` / `SANDBOX_OPENAI_API_KEY` are
   not set in the environment that will run the orchestrator).
2. That's it. Per `osqltjnr` §7 "v1 Demo Codex Auth — locked path", the orchestrator copies
   the host's `~/.codex/auth.json` into the sandbox at `/workspace/codex-home/auth.json` as
   part of the step-8 `uploadFiles` batch and sets `CODEX_HOME=/workspace/codex-home` in the
   sandbox env via `daytona.createSandbox`. No manual copy needed; if `~/.codex/auth.json` is
   missing on the host, `runOne` fails fast with a typed `MissingCodexAuthError`.

## Where to look in the codebase

- `apps/symphony-orchestrator/src/orchestrator/service.ts` (when osqltjnr lands) — runOne
  pipeline; auth-copy is part of the step-8 `uploadFiles` batch per the locked path.
- `playgrounds/symphony-daytona-playground/src/smoke-app-server.ts` — reference flow that
  copies `auth.json` into `CODEX_HOME=/workspace/codex-home` (per spec line 113); the
  orchestrator follows the same shape.

## How to verify

Once the sandbox is created and the orchestrator has copied auth in, you can confirm by SSHing
into the sandbox (autoDeleteInterval=-1 leaves it alive) and running:

```
ls -la $CODEX_HOME
codex login status   # expected: "Logged in using ChatGPT"
```

If the answer is "Not logged in" or the path is `apikey`, the orchestrator's auth bootstrap
didn't fire — most likely the host's `~/.codex/auth.json` was missing or unreadable, or the
sandbox env included an `OPENAI_API_KEY` value that masked it.

## Codex CLI version

The protocol shapes verified by the 2026-05-04 smoke (spec lines 200-222) are pinned to
`codex-cli 0.128.0`. The `symphony-codex-bun` snapshot bakes this version in. If the snapshot
ships with a newer version (e.g., the maintainer rebuilt it), the protocol contract may differ
and scenarios can fail in surprising ways. Capture the actual `codex --version` from inside the
sandbox in your result file.

## Out of scope

- Provisioning a fresh OpenAI account for the demo.
- API-key auth (`AUTH_PROBE_OPENAI_API_KEY` in the playground supports it but QA scenarios use
  ChatGPT auth only).
- Sharing auth across sandboxes (each sandbox gets its own copy).
- Persisting auth into the snapshot itself.

## Cleanup

The sandbox is destroyed via `helpers/cleanup.md`. No auth state leaks once the sandbox is
deleted (the file lived inside it). The host's `~/.codex/auth.json` is unchanged.
