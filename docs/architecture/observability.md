# Symphony Orchestrator Observability

This focused doc owns the logger bootstrap contract split from
`docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md` under
`### Effect Implementation Shape`. Source files in
`apps/symphony-orchestrator/src/observability/` `drift link` here.

## Structured Logs

The orchestrator entry point installs `structuredLoggerLayer`, replacing Effect's default logger
with newline-delimited JSON on stdout. Each line has these base fields:

- `level` — lower-case Effect log level label, for example `info`, `warn`, or `error`.
- `timestamp` — ISO-8601 timestamp from the Effect logger event.
- `message` — the logged message. Single-message arrays are flattened to the message value; empty
  automatic error reports render as `unhandled failure` when a cause is present.
- `fiber_id` — Effect fiber id for local debugging.

Effect log annotations are promoted to top-level JSON keys. Runtime modules should annotate logs
with `issue_id`, `issue_display_id`, `attempt`, and `sandbox_id` whenever those values are known.
Missing values are omitted rather than filled with placeholders.

## Lifecycle Emissions

Every state-flow row in the umbrella spec emits exactly one log line, named `<phase>.<event>`.
The orchestrator's `runOne` and `runOneTick` pipelines own these emissions. Annotation context
(`issue_id`, `issue_display_id`, `attempt`, `sandbox_id`) is set at the `runOne` boundary via
`Effect.annotateLogsScoped` so call sites only emit the message name plus message-specific
extras (for example `worker_status`, `branch`, `run_id`).

Archive happy-path messages, in order: `tick.start`, `candidate.selected`, `claim.acquired`,
`sandbox.created`, `source.uploaded`, `turn.started`, `turn.completed`, `bundle.decoded`,
`integration.succeeded`, `fp.done`. `githubClone`/PR runs skip bundle decode and host
integration after a completed worker turn and emit `worker.handoff.completed` with the branch,
run id, and sandbox id; until worker-side fp no-clone property writes are proven, the local
run result remains gated instead of integrated. Failure paths emit a static `failure` message at
warning level with `failure_code` (for example `F11` for an empty bundle), `error_tag`, and
`reason` annotations — log searches should filter on `failure_code` rather than the message text.

`source.uploaded` is the stable boundary after sandbox input material is present. In archive mode
that includes the source archive, prompt, and Codex auth before setup. In `githubClone` mode it
fires after clone setup succeeds and includes prompt, Codex auth, and a secret-bearing worker env
bridge uploaded outside the repo immediately before session start.

## Log Level

`LOG_LEVEL` is the only runtime knob for log verbosity. Supported values are `trace`, `debug`,
`info`, `warn`, `warning`, `error`, and `fatal`; invalid or absent values default to `info`.
There is no CLI `--debug` or `--quiet` flag in v1.

## Spans And Traces

`Effect.withSpan` trace context is emitted via Effect's span annotations:
`effect.traceId`, `effect.spanId`, and `effect.spanName`. Effect log spans are emitted under a
`spans` object keyed by span name, with elapsed milliseconds as the value. Modules should keep using
`Effect.withSpan` for trace boundaries and `Effect.withLogSpan` when elapsed log-span timing is
useful directly in JSON log output.

`EFFECT_TRACE=1` is reserved for Effect runtime tracing at the command line. The `dev` package
script sets it, but v1 does not install an OpenTelemetry exporter or change the JSON logger shape
based on this variable.
