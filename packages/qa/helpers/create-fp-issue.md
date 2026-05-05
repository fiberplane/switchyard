# Create FP Issue

## Goal

Create an `fp` issue with the right `symphony_*` properties so the orchestrator's eligibility
filter dispatches it on the next poll tick.

## Background

Per ADR `D4b` (`docs/architecture/0001-symphony-deviations.md`), the `fp` property surface is
exactly five properties registered as a custom-property extension:

- `symphony_ready` — `"true"` | `"false"` — gate for dispatch
- `symphony_state` — `"idle"` | `"active"` | `"end"` | `"needs-attention"`
- `symphony_attempt` — string-encoded integer
- `symphony_artifact` — string (set on success: `"symphony/<issue-id>"`)
- `symphony_last_error` — string (set on failure)

Source-of-truth schema lives at `apps/symphony-orchestrator/src/fp/symphony-properties.ts`.

The eligibility decision is made by `FpService.fetchCandidates`
(`apps/symphony-orchestrator/src/fp/service.ts`) which delegates to
`apps/symphony-orchestrator/src/fp/eligibility.ts`. The decision table picks up issues that are:

- `status=todo`
- `symphony_ready="true"`
- `symphony_state` is **not** `"active"` and **not** `"needs-attention"` (i.e. `"idle"` or
  `"end"` — the row 3 default)
- All declared dependencies are terminal
- No open child issues
- Not in the orchestrator's in-memory running set

## What needs to happen

1. **Verify the `symphony_*` extension is registered.** Run a throwaway create against the
   project: `fp issue create --title "qa-extension-probe" --property symphony_ready=true`. If
   `fp` accepts the property, the extension is loaded and you can move on (delete the probe
   issue afterward). If `fp` rejects `symphony_ready` as unknown, the extension is **missing
   from project bootstrap**, not from your QA flow — surface as a setup blocker; do NOT
   attempt to register it as part of the scenario. The schema lives in
   `apps/symphony-orchestrator/src/fp/symphony-properties.ts`; ADR D4b assumes it's already
   bootstrapped.
2. Create the issue with `fp issue create`, specifying:
   - A `--title` describing the task (the worker reads this).
   - A `--description` containing the actual task body (markdown — the worker reads this; see
     fixtures for the canonical `sample-code-task.md` shape).
   - `--property symphony_ready=true` (the gate).
   - Defaults for the other four properties — the orchestrator picks them up via
     `decodeSymphonyProperties` which falls back to `SYMPHONY_PROPERTIES_DEFAULTS`
     (`symphony_state=idle`, `symphony_ready=false`, others `undefined`). You only need to set
     `symphony_ready=true` explicitly; the others can be omitted at create time.
3. Verify the issue appears via `fp issue get <id>` with the expected properties.
4. Capture the issue ID for use in the scenario (the display ID; the orchestrator logs it as
   `issue_display_id` per the structured-log contract — spec line 769-770).

## Where to look in the codebase

- `apps/symphony-orchestrator/src/fp/symphony-properties.ts` — the schema. **Drift target for
  any scenario that embeds `symphony_*` flag patterns.**
- `apps/symphony-orchestrator/src/fp/eligibility.ts` — the decision table.
- `apps/symphony-orchestrator/src/fp/service.ts` — `FpService.fetchCandidates` and atomic-write
  surfaces (`claimIssue`, `markCompleted`, `markNeedsAttention`).
- The repo-level `fp` extension file (under `.fp/extensions/`) that registers the five
  properties.

## Command pattern

```
fp issue create \
  --title "<short title — read by the worker>" \
  --description "$(cat packages/qa/fixtures/sample-code-task.md)" \
  --property symphony_ready=true
```

The exact flag shapes for `--property` come from the `fp` CLI; if `fp issue create` rejects an
unregistered property, the extension isn't loaded and step 1 above hasn't been done.

## How to verify

```
fp issue get <id>
```

Expected:

- `status: todo`
- `symphony_ready: true`
- `symphony_state: idle` (default — may be unset if the extension doesn't write defaults at
  create time; the orchestrator's `decodeSymphonyProperties` treats unset as `idle` per
  `SYMPHONY_PROPERTIES_DEFAULTS`)
- No `symphony_artifact`, `symphony_attempt`, or `symphony_last_error` set

## Variations for failure-path scenarios (deferred — SWYRD-euvkxyra)

The four failure-path scenarios (02-05) are deferred to follow-up `SWYRD-euvkxyra` under epic
`SWYRD-uouprnfv`. When that ticket is claimed, the variations below describe the per-scenario
flag patterns and fixture choices the implementer will need:

- **Worker-blocked (scenario 02):** same flag pattern; description uses
  `fixtures/sample-blocked-task.md` (asks for an impossible precondition).
- **Research task (scenario 03):** same flag pattern; description uses
  `fixtures/sample-research-task.md` (explicit "no code changes expected; explore and summarize
  inline").
- **Re-arm (scenario 04):** does NOT create a new issue — re-uses the issue from scenario 02
  via `fp issue update --status todo`. See `depends-on:` in scenario 04's frontmatter.
- **Signal-shutdown (scenario 05):** re-uses `fixtures/sample-code-task.md` from scenario 01;
  task content is irrelevant — the verification is about timing the SIGINT mid-turn.

## Cleanup

Per `helpers/cleanup.md`. `fp` issues created for QA scenarios live in the project; either:

- Leave them in place as a record of the run (the `symphony_*` properties tell the story).
- Delete them via `fp issue update --status archived <id>` (or whatever your project's archival
  flow is) once the result file is captured.

Do not bulk-delete `fp` data — the project may also contain real implementation tickets.
