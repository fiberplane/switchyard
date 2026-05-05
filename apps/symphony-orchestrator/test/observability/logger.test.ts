import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { structuredLoggerLayer } from "../../src/observability/logger.js";

const runWithLogs = async (
  effect: Effect.Effect<void>,
  env: Record<string, string | undefined> = {},
) => {
  const lines: string[] = [];
  await Effect.runPromise(
    effect.pipe(
      Effect.provide(
        structuredLoggerLayer({
          env,
          sink: (line) => lines.push(line),
        }),
      ),
    ),
  );
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("structuredLoggerLayer", () => {
  test("emits JSON lines with level, timestamp, message, and annotations", async () => {
    const logs = await runWithLogs(
      Effect.logInfo("dispatching").pipe(
        Effect.annotateLogs({
          issue_display_id: "SWYRD-x",
          issue_id: "x",
          attempt: 1,
          sandbox_id: "sandbox-1",
        }),
      ),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("info");
    expect(typeof logs[0]!.timestamp).toBe("string");
    expect(logs[0]!.message).toBe("dispatching");
    expect(logs[0]!.issue_display_id).toBe("SWYRD-x");
    expect(logs[0]!.issue_id).toBe("x");
    expect(logs[0]!.attempt).toBe(1);
    expect(logs[0]!.sandbox_id).toBe("sandbox-1");
  });

  test("respects LOG_LEVEL from the environment", async () => {
    const logs = await runWithLogs(
      Effect.gen(function* () {
        yield* Effect.logDebug("debug");
        yield* Effect.logInfo("info");
        yield* Effect.logWarning("warn");
      }),
      { LOG_LEVEL: "warn" },
    );

    expect(logs.map((log) => log.message)).toEqual(["warn"]);
    expect(logs[0]!.level).toBe("warn");
  });

  test("preserves Effect.withSpan structure", async () => {
    const logs = await runWithLogs(Effect.logInfo("inside").pipe(Effect.withSpan("runOne")));

    expect(logs[0]!["effect.spanName"]).toBe("runOne");
    expect(typeof logs[0]!["effect.traceId"]).toBe("string");
    expect(typeof logs[0]!["effect.spanId"]).toBe("string");
  });
});
