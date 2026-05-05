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
