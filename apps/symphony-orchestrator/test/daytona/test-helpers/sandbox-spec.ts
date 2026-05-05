import type { DaytonaSandboxSpec } from "../../../src/daytona/models.js";
import { daytonaTestConfig } from "./stack.js";

type SandboxSpecOverrides = {
  readonly testRunId: string;
  readonly name?: string;
  readonly labels?: Record<string, string>;
  readonly envVars?: Record<string, string>;
  readonly autoStopInterval?: number;
  readonly autoDeleteInterval?: number;
  readonly createTimeoutSec?: number;
};

const shortRunId = (testRunId: string): string => testRunId.replaceAll("-", "").slice(0, 12);

export const buildTestSandboxSpec = (overrides: SandboxSpecOverrides): DaytonaSandboxSpec => {
  const createdAtMs = String(Date.now());
  const suffix = `${shortRunId(overrides.testRunId)}-${createdAtMs}`;

  return {
    name: overrides.name ?? `symphony-test-${suffix}`,
    snapshotName: daytonaTestConfig.snapshotName,
    language: "typescript",
    labels: {
      app: "symphony-test",
      test_run_id: overrides.testRunId,
      created_at_ms: createdAtMs,
      ...overrides.labels,
    },
    envVars: {
      ...overrides.envVars,
    },
    autoStopInterval: overrides.autoStopInterval ?? 15,
    autoDeleteInterval: overrides.autoDeleteInterval ?? -1,
    createTimeoutSec: overrides.createTimeoutSec ?? 300,
  };
};
