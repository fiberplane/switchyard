import { Daytona } from "@daytona/sdk";

import type { DaytonaConfig } from "../../../src/daytona/models.js";
import { repairRunnerSchedulingIfEnabled } from "./repair-runner-scheduling.js";

export const daytonaTestConfig: DaytonaConfig = {
  apiUrl: "http://localhost:33000/api",
  apiKey: "switchyard-test-api-key",
  target: "us",
  snapshotName: "symphony-test-base",
};

const appRoot = new URL("../../../", import.meta.url);
const stackProject = "switchyard-test";
const stackUpCommand = "bun run test:daytona:up";
const healthUrl = "http://localhost:33000/health";

class DaytonaTestStackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaTestStackError";
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (stream === null) {
    return "";
  }
  return await new Response(stream).text();
};

const runStackUp = async (): Promise<void> => {
  const proc = Bun.spawn(["bun", "run", "test:daytona:up"], {
    cwd: appRoot.pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    readStream(proc.stdout),
    readStream(proc.stderr),
  ]);

  if (exitCode !== 0) {
    throw new DaytonaTestStackError(
      [
        `Daytona test stack '${stackProject}' failed to boot via '${stackUpCommand}'.`,
        "stdout:",
        stdout.trim(),
        "stderr:",
        stderr.trim(),
      ].join("\n"),
    );
  }
};

const waitForHealth = async (): Promise<void> => {
  const deadline = Date.now() + 120_000;
  let lastReason = "not checked";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }

    await sleep(1_000);
  }

  throw new DaytonaTestStackError(
    [
      `Daytona test stack '${stackProject}' is not reachable at ${healthUrl}.`,
      `Last health error: ${lastReason}`,
      `Boot it with '${stackUpCommand}' from apps/symphony-orchestrator.`,
    ].join("\n"),
  );
};

export const ensureStackUp = async (): Promise<void> => {
  await runStackUp();
  await waitForHealth();
  await repairRunnerSchedulingIfEnabled(daytonaTestConfig.target);
};

const makeDaytona = (): Daytona =>
  new Daytona({
    apiKey: daytonaTestConfig.apiKey,
    apiUrl: daytonaTestConfig.apiUrl,
    target: daytonaTestConfig.target,
    _experimental: {
      otelEnabled: false,
    },
  });

export const listTestSandboxes = async (labels: Record<string, string> = {}) => {
  const daytona = makeDaytona();
  const response = await daytona.list(
    {
      app: "symphony-test",
      ...labels,
    },
    1,
    100,
  );
  return response.items;
};

export const deleteByTestRunId = async (testRunId: string): Promise<void> => {
  const sandboxes = await listTestSandboxes({ test_run_id: testRunId });
  await Promise.allSettled(sandboxes.map((sandbox) => sandbox.delete(120)));
};
