import type { Sandbox } from "@daytona/sdk";

import { createDaytonaClient, isDaytonaNotFound } from "../../../src/daytona/daytona-client.js";
import type { DaytonaConfig, DaytonaSandboxSpec } from "../../../src/daytona/models.js";
import { RemoteDaytonaCleanupError } from "./errors.js";

const listPageSize = 100;
const deletionDeadlineMs = 120_000;
const deletionPollMs = 1_000;
const remoteSourceLabel = "remote-daytona";

type RemoteSandboxSpecOverrides = {
  readonly testRunId: string;
  readonly snapshotName: string;
  readonly owner: string;
  readonly name?: string;
  readonly labels?: Record<string, string>;
  readonly envVars?: Record<string, string>;
  readonly autoStopInterval?: number;
  readonly autoDeleteInterval?: number;
  readonly createTimeoutSec?: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type CleanupReporter = (message: string) => void;

export const remoteKeepSandbox = (env: Record<string, string | undefined> = process.env): boolean =>
  env.SWITCHYARD_REMOTE_DAYTONA_KEEP_SANDBOX === "1";

export const remoteOwnerLabel = (env: Record<string, string | undefined>): string =>
  env.SWITCHYARD_REMOTE_DAYTONA_OWNER ?? "switchyard-test";

const shortRunId = (testRunId: string): string => testRunId.replaceAll("-", "").slice(0, 12);

export const buildRemoteTestSandboxSpec = (
  overrides: RemoteSandboxSpecOverrides,
): DaytonaSandboxSpec => {
  const createdAtMs = String(Date.now());
  const suffix = `${shortRunId(overrides.testRunId)}-${createdAtMs}`;

  return {
    name: overrides.name ?? `symphony-remote-test-${suffix}`,
    snapshotName: overrides.snapshotName,
    language: "typescript",
    labels: {
      ...overrides.labels,
      app: "symphony-test",
      source: remoteSourceLabel,
      test_run_id: overrides.testRunId,
      created_at_ms: createdAtMs,
      owner: overrides.owner,
    },
    envVars: {
      ...overrides.envVars,
    },
    autoStopInterval: overrides.autoStopInterval ?? 15,
    autoDeleteInterval: overrides.autoDeleteInterval ?? -1,
    createTimeoutSec: overrides.createTimeoutSec ?? 300,
  };
};

const safeLabels = (sandbox: Sandbox): Record<string, string> => {
  const labels =
    "labels" in sandbox && typeof sandbox.labels === "object" && sandbox.labels !== null
      ? sandbox.labels
      : {};
  return Object.fromEntries(
    Object.entries(labels as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
};

export const listRemoteTestSandboxes = async (
  config: DaytonaConfig,
  testRunId: string,
): Promise<Sandbox[]> => {
  if (testRunId.length === 0) {
    throw new RemoteDaytonaCleanupError({
      reason: "remote Daytona cleanup refused: missing test_run_id",
    });
  }

  const daytona = createDaytonaClient(config);
  const labels = {
    app: "symphony-test",
    source: remoteSourceLabel,
    test_run_id: testRunId,
  };
  const sandboxes: Sandbox[] = [];
  let page = 1;

  while (true) {
    const response = await daytona.list(labels, page, listPageSize);
    sandboxes.push(...response.items);

    if (page >= response.totalPages || response.items.length === 0) {
      return sandboxes;
    }

    page += 1;
  }
};

const waitForDeleted = async (config: DaytonaConfig, sandboxId: string): Promise<void> => {
  const client = createDaytonaClient(config);
  const deadline = Date.now() + deletionDeadlineMs;

  while (Date.now() < deadline) {
    try {
      const sandbox = await client.get(sandboxId);
      if ("state" in sandbox && sandbox.state === "destroyed") {
        return;
      }
    } catch (error) {
      if (isDaytonaNotFound(error)) {
        return;
      }
      throw error;
    }

    await sleep(deletionPollMs);
  }

  throw new RemoteDaytonaCleanupError({
    reason: `remote Daytona sandbox ${sandboxId} did not delete within ${deletionDeadlineMs}ms`,
  });
};

const assertSwitchyardRemoteTestSandbox = (sandbox: Sandbox, testRunId: string): void => {
  const labels = safeLabels(sandbox);
  if (
    labels.app !== "symphony-test" ||
    labels.source !== remoteSourceLabel ||
    labels.test_run_id !== testRunId
  ) {
    throw new RemoteDaytonaCleanupError({
      reason: `remote Daytona cleanup refused sandbox ${sandbox.id}: labels did not match Switchyard remote test selectors`,
    });
  }
};

export const cleanupRemoteTestSandboxes = async (
  config: DaytonaConfig,
  testRunId: string,
  report: CleanupReporter = console.warn,
): Promise<void> => {
  const sandboxes = await listRemoteTestSandboxes(config, testRunId);

  for (const sandbox of sandboxes) {
    const labels = safeLabels(sandbox);
    try {
      assertSwitchyardRemoteTestSandbox(sandbox, testRunId);
      await sandbox.delete(120);
      await waitForDeleted(config, sandbox.id);
    } catch (error) {
      report(
        `remote Daytona cleanup failed for sandbox ${sandbox.id} labels=${JSON.stringify(labels)}`,
      );
      throw error;
    }
  }
};

export const reportKeptRemoteSandboxes = async (
  config: DaytonaConfig,
  testRunId: string,
  report: CleanupReporter = console.warn,
): Promise<void> => {
  const sandboxes = await listRemoteTestSandboxes(config, testRunId);
  for (const sandbox of sandboxes) {
    report(
      `remote Daytona sandbox kept: ${sandbox.id} labels=${JSON.stringify(safeLabels(sandbox))}`,
    );
  }
};
