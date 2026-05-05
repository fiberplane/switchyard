// Structured logger bootstrap for the orchestrator entry point.
// Contract lives in docs/architecture/observability.md (drift-bound).

import { Cause, HashMap, Layer, List, Logger, LogLevel } from "effect";

export type LogSink = (line: string) => void;

export type StructuredLoggerOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly sink?: LogSink;
};

const logLevels = {
  debug: LogLevel.Debug,
  error: LogLevel.Error,
  fatal: LogLevel.Fatal,
  info: LogLevel.Info,
  trace: LogLevel.Trace,
  warn: LogLevel.Warning,
  warning: LogLevel.Warning,
} as const;

export const logLevelFromEnv = (
  env: Record<string, string | undefined> = process.env,
): LogLevel.LogLevel => {
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) {
    return LogLevel.Info;
  }
  return logLevels[raw as keyof typeof logLevels] ?? LogLevel.Info;
};

const renderMessage = (message: unknown, cause: Cause.Cause<unknown>): unknown => {
  if (Array.isArray(message) && message.length === 0 && !Cause.isEmpty(cause)) {
    return "unhandled failure";
  }
  if (Array.isArray(message) && message.length === 1) {
    return message[0];
  }
  return message;
};

const renderSpans = (spans: Logger.Logger.Options<unknown>["spans"], now: number) => {
  const rendered: Record<string, number> = {};
  for (const span of List.toArray(spans)) {
    rendered[span.label] = Math.max(0, now - span.startTime);
  }
  return rendered;
};

export const makeStructuredLogger = (sink: LogSink = (line) => process.stdout.write(`${line}\n`)) =>
  Logger.make<unknown, void>(({ annotations, cause, date, fiberId, logLevel, message, spans }) => {
    const annotationFields = Object.fromEntries(HashMap.toEntries(annotations));
    const spanFields = renderSpans(spans, date.getTime());
    const line = {
      level: logLevel.label.toLowerCase(),
      timestamp: date.toISOString(),
      message: renderMessage(message, cause),
      fiber_id: fiberId.toString(),
      ...annotationFields,
      ...(Object.keys(spanFields).length === 0 ? {} : { spans: spanFields }),
      ...(Cause.isEmpty(cause) ? {} : { cause: cause.toString() }),
    };
    sink(JSON.stringify(line));
  });

export const structuredLoggerLayer = (options: StructuredLoggerOptions = {}) =>
  Layer.merge(
    Logger.replace(
      Logger.defaultLogger,
      Logger.withSpanAnnotations(makeStructuredLogger(options.sink)),
    ),
    Logger.minimumLogLevel(logLevelFromEnv(options.env)),
  );
