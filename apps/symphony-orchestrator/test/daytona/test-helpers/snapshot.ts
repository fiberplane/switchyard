import { Daytona, DaytonaNotFoundError, Image } from "@daytona/sdk";

import { DaytonaTestSnapshotError } from "./errors.js";
import { daytonaTestConfig, ensureStackUp } from "./stack.js";

const snapshotName = "symphony-test-base";
const inactiveSnapshotName = "symphony-test-inactive";
const dockerfilePath = new URL("../Dockerfile.snapshot", import.meta.url).pathname;
const snapshotDeadlineMs = 600_000;
const snapshotPollMs = 2_000;

const describeUnknown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const makeDaytona = (): Daytona =>
  new Daytona({
    apiKey: daytonaTestConfig.apiKey,
    apiUrl: daytonaTestConfig.apiUrl,
    target: daytonaTestConfig.target,
    _experimental: {
      otelEnabled: false,
    },
  });

const readResponseBody = async (response: Response): Promise<string> => {
  const body = await response.text();
  return body.length === 0 ? "<empty body>" : body;
};

const deactivateSnapshot = async (snapshotId: string): Promise<void> => {
  const response = await fetch(`${daytonaTestConfig.apiUrl}/snapshots/${snapshotId}/deactivate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daytonaTestConfig.apiKey}`,
    },
  });

  if (!response.ok) {
    throw new DaytonaTestSnapshotError({
      reason: `Failed to deactivate snapshot ${snapshotId}: HTTP ${response.status} ${await readResponseBody(response)}`,
    });
  }
};

const waitForActiveSnapshot = async (daytona: Daytona, name: string): Promise<void> => {
  const deadline = Date.now() + snapshotDeadlineMs;

  while (Date.now() < deadline) {
    const snapshot = await daytona.snapshot.get(name);
    if (snapshot.state === "active") {
      return;
    }
    if (snapshot.state === "error" || snapshot.state === "build_failed") {
      throw new DaytonaTestSnapshotError({
        reason: `Snapshot ${name} is ${snapshot.state}: ${snapshot.errorReason ?? "unknown reason"}`,
      });
    }
    if (snapshot.state === "inactive") {
      await daytona.snapshot.activate(snapshot);
    }

    await sleep(snapshotPollMs);
  }

  throw new DaytonaTestSnapshotError({
    reason: `Snapshot ${name} did not become active within ${snapshotDeadlineMs}ms`,
  });
};

const waitForSnapshotState = async (
  daytona: Daytona,
  name: string,
  expectedState: string,
): Promise<void> => {
  const deadline = Date.now() + snapshotDeadlineMs;

  while (Date.now() < deadline) {
    const snapshot = await daytona.snapshot.get(name);
    if (snapshot.state === expectedState) {
      return;
    }
    if (snapshot.state === "error" || snapshot.state === "build_failed") {
      throw new DaytonaTestSnapshotError({
        reason: `Snapshot ${name} is ${snapshot.state}: ${snapshot.errorReason ?? "unknown reason"}`,
      });
    }

    await sleep(snapshotPollMs);
  }

  throw new DaytonaTestSnapshotError({
    reason: `Snapshot ${name} did not become ${expectedState} within ${snapshotDeadlineMs}ms`,
  });
};

export const ensureTestSnapshot = async (): Promise<void> => {
  await ensureStackUp();
  const daytona = makeDaytona();

  try {
    await daytona.snapshot.get(snapshotName);
    await waitForActiveSnapshot(daytona, snapshotName);
    return;
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) {
      throw error;
    }
  }

  try {
    const snapshot = await daytona.snapshot.create(
      {
        name: snapshotName,
        image: Image.fromDockerfile(dockerfilePath),
        resources: {
          cpu: 1,
          memory: 1,
          disk: 3,
        },
      },
      { timeout: 600 },
    );

    if (snapshot.state !== "active") {
      await waitForActiveSnapshot(daytona, snapshotName);
    }
  } catch (error) {
    if (error instanceof DaytonaTestSnapshotError) {
      throw error;
    }
    throw new DaytonaTestSnapshotError({
      reason: `Failed to create Daytona test snapshot ${snapshotName}: ${describeUnknown(error)}`,
    });
  }
};

const ensureCreatedSnapshot = async (daytona: Daytona, name: string): Promise<void> => {
  try {
    await daytona.snapshot.get(name);
    return;
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) {
      throw error;
    }
  }

  await daytona.snapshot.create(
    {
      name,
      image: Image.fromDockerfile(dockerfilePath),
      resources: {
        cpu: 1,
        memory: 1,
        disk: 3,
      },
    },
    { timeout: 600 },
  );
};

export const ensureInactiveTestSnapshot = async (): Promise<string> => {
  await ensureStackUp();
  const daytona = makeDaytona();
  await ensureCreatedSnapshot(daytona, inactiveSnapshotName);

  const snapshot = await daytona.snapshot.get(inactiveSnapshotName);
  if (snapshot.state === "inactive") {
    return inactiveSnapshotName;
  }

  if (snapshot.state !== "active") {
    await waitForActiveSnapshot(daytona, inactiveSnapshotName);
  }

  const activeSnapshot = await daytona.snapshot.get(inactiveSnapshotName);
  await deactivateSnapshot(activeSnapshot.id);
  await waitForSnapshotState(daytona, inactiveSnapshotName, "inactive");

  return inactiveSnapshotName;
};
