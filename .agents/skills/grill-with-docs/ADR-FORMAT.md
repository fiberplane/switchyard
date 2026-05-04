# Capturing architectural decisions

This repo does not use a separate ADR tree. Settled conventions live in `docs/patterns/`; accepted architectural shape and rationale live in `docs/architecture/`; unshipped design work lives in `docs/proposals/active/`. When an accepted non-obvious decision needs a paper trail, capture it inline as a short rationale section inside the relevant `docs/architecture/<topic>.md` (or `docs/patterns/<topic>.md`) rather than creating a separate ADR file.

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

Keep the rationale next to the thing it justifies. Proposals carry `Status:` while a decision is
still in flight. Once the decision is accepted and load-bearing, move the accepted state and any
essential rationale into the relevant architecture or pattern doc; the completed proposal keeps the
historical context.

## When to capture

All three must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any is missing, skip it. A pattern note in `docs/patterns/` is often the right home — it captures *how we write code* rather than *why we picked X over Y*.

### What qualifies

- **Architectural shape.** "`fp` owns durable task state; the local orchestrator owns dispatch and sandbox lifecycle."
- **Integration patterns across boundaries.** "Daytona execution is wrapped by an adapter; interior services talk to typed Effect services, not the raw SDK."
- **Technology choices that carry lock-in.** Database, sync engine, auth provider, deployment target. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Workers return artifacts; they do not claim work or perform final issue transitions." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're uploading a repo archive to Daytona instead of relying on local worktrees because remote sandboxes cannot share fp's local worktree identity." Anything where a reasonable reader would assume the opposite stops the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "Local Daytona demos must probe host reachability instead of assuming `host.docker.internal`."
- **Rejected alternatives when the rejection is non-obvious.** If we considered giving workers direct tracker authority and rejected it for subtle reasons, record it — otherwise someone will suggest it again in six months.

### Where decisions land

- **System shape / data flow / process model** → `docs/architecture/<topic>.md`
- **Unshipped design work** → `docs/proposals/active/` (proposals carry status)
- **How we write code in light of the decision** → `docs/patterns/<topic>.md`
- **Mechanically enforceable** → an ast-grep rule under `rules/` (with a test under `rule-tests/`), referenced from the pattern doc

If the decision is genuinely settled before you start writing — no live trade-off, no alternatives in flight — skip the rationale section entirely and just describe the convention.
