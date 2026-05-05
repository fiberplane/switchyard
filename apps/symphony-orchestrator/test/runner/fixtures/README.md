# runner transport fixtures

Real send/recv frames captured from a local `codex app-server` session. Used by the
runner-transport tests (`SWYRD-otrkohwm`) to verify the framing layer against actual
protocol output rather than hand-crafted approximations.

Each fixture is JSONL with one `{ ts, direction: "send" | "recv", message }` entry per
line. The matching `.meta.json` records the codex-cli version, the prompt, the
thread/start and turn/start params, and the frame counts.

| Fixture                    | Shape                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `happy-path-turn.jsonl`    | initialize → thread/start → turn/start → streamed items → turn/completed; no approval requests                                   |
| `approval-roundtrip.jsonl` | same handshake, plus server-initiated approval requests (auto-approved) and the resulting `serverRequest/resolved` notifications |

To regenerate (costs a real codex turn per variant):

```bash
bun run --cwd playgrounds/symphony-daytona-playground capture:fixtures
```

Codex CLI version pin and approach are documented at
`playgrounds/symphony-daytona-playground/src/capture-protocol-fixtures.ts`.
