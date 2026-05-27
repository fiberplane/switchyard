# Symphony Daytona Playground

Smoke playground for the Daytona-backed Symphony/Codex runner path. It builds a tiny
repository archive, creates a Daytona sandbox from the `symphony-codex-bun` snapshot by
default, uploads a prompt and Codex auth into the sandbox, asks Codex to edit the tiny repo,
checks the result, probes sandbox-to-host reachability, downloads non-source smoke evidence,
and deletes the sandbox.

Generated evidence stays under the ignored local `artifacts/` directory. Do not copy historical
smoke output into the repo; it may contain token-bearing logs or auth-derived state.

## Preflight

Required host tools and services:

- Bun installed from the repo root toolchain.
- Daytona Cloud credentials available through `DAYTONA_API_KEY`.
- `DAYTONA_API_URL` set only when you need an SDK endpoint override.
- `DAYTONA_API_KEY` exported in the shell, or `DAYTONA_API_KEY_FILE` pointing to a mode-`600`
  local key file.
- `DAYTONA_TARGET` set only when the SDK default target is not correct.
- `DAYTONA_SNAPSHOT` set if the default `symphony-codex-bun` snapshot is not correct.
- The selected Daytona snapshot must be active and include Node, npm, Bun, Git, and Codex.
- Codex auth available at `CODEX_AUTH_JSON`, or at `$HOME/.codex/auth.json` by default.

Do not place API keys, Codex auth, `.env` files, generated archives, or artifact logs in this
directory. Root `.gitignore` blocks the known generated and local credential paths.

## Commands

From the repo root:

```bash
bun install
bun run --cwd playgrounds/symphony-daytona-playground typecheck
bun run --cwd playgrounds/symphony-daytona-playground demo
bun run --cwd playgrounds/symphony-daytona-playground smoke
bun run --cwd playgrounds/symphony-daytona-playground auth:probe
```

The smoke command builds `dist/smoke.mjs`, writes generated artifacts under
`playgrounds/symphony-daytona-playground/artifacts/`, and uploads the configured Codex auth only
into the temporary Daytona sandbox. Use `smoke:bun` to run the TypeScript source directly:

```bash
bun run --cwd playgrounds/symphony-daytona-playground smoke:bun
```

The auth probe isolates copied ChatGPT `auth.json`, inherited `OPENAI_API_KEY`, and
`codex login --with-api-key` behavior in disposable `CODEX_HOME` directories inside one Daytona
sandbox. It writes only redacted command results under `artifacts/`. Set
`AUTH_PROBE_OPENAI_API_KEY` only when intentionally testing the real API-key path.

The fixture-capture command spawns `codex app-server` **locally** (not in Daytona) and records
real send/recv JSON-RPC frames as JSONL fixtures the runner-transport tests will replay (see
`SWYRD-dhkyapwn`). It costs a real codex turn per variant; the prompts are minimal to keep usage
small. By default it writes into `apps/symphony-orchestrator/test/runner/fixtures/`.

```bash
bun run --cwd playgrounds/symphony-daytona-playground capture:fixtures              # all variants
bun run --cwd playgrounds/symphony-daytona-playground capture:fixtures happy-path
bun run --cwd playgrounds/symphony-daytona-playground capture:fixtures approval-roundtrip
```

Override `FIXTURE_OUT_DIR` to write elsewhere (e.g. `artifacts/` while iterating). Override
`CODEX_BIN` and `CODEX_AUTH_JSON` if codex is not on `$PATH` or auth lives outside `~/.codex`.
