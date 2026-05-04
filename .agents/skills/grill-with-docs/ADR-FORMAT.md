# Capturing architectural decisions

This repo doesn't use ADRs and doesn't have a `docs/proposals/` folder. Settled conventions live in `docs/patterns/`; settled architectural shape lives in `docs/architecture/`. When a non-obvious decision needs a paper trail, capture it inline as a short rationale section inside the relevant `docs/architecture/<topic>.md` (or `docs/patterns/<topic>.md`) — not as a separate file.

See `docs/README.md` for the wider convention.

## Shape

When you do capture a decision inline, a tight rationale section is enough. Adapt to the decision at hand — these headers are typical, not mandatory:

```md
## Decision: {short title}

**Status**: provisional | accepted
**Date**: YYYY-MM-DD

### Summary

| Component | Choice |
|-----------|--------|
| ...       | ...    |

### Why {chosen option}

- bullet rationale

### Why not {rejected option}

- bullet rationale (only when the rejection isn't obvious)
```

Keep the rationale next to the thing it justifies — embed it in the architecture doc rather than orphaning it in its own file. Once the decision is settled and load-bearing, drop the `Status:` line; the rationale stays.

## When to capture

All three must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any is missing, skip it. A pattern note in `docs/patterns/` is often the right home — it captures *how we write code* rather than *why we picked X over Y*.

### What qualifies

- **Architectural shape.** "Single SQLite per project; one Y.Doc per issue."
- **Integration patterns between contexts / processes.** "Main process owns the sync engine; renderer talks to it via Effect RPC, not direct DB access."
- **Technology choices that carry lock-in.** Database, sync engine, auth provider, deployment target. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Local activity stays local; only Yjs updates cross the wire." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of Drizzle here because X." Anything where a reasonable reader would assume the opposite stops the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "WASM boot overhead is unacceptable for CLI invocations."
- **Rejected alternatives when the rejection is non-obvious.** If we considered LiveStore and picked Yjs for subtle reasons, record it — otherwise someone will suggest LiveStore again in six months.

### Where decisions land

- **System shape / data flow / process model** → `docs/architecture/<topic>.md`
- **How we write code in light of the decision** → `docs/patterns/<topic>.md`
- **Mechanically enforceable** → an ast-grep rule under `rules/` (with a test under `rule-tests/`), referenced from the pattern doc

If the decision is genuinely settled before you start writing — no live trade-off, no alternatives in flight — skip the rationale section entirely and just describe the convention.
