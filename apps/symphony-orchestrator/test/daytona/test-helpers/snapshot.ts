import { Daytona, DaytonaNotFoundError, Image } from "@daytona/sdk";

import { daytonaTestConfig, ensureStackUp } from "./stack.js";

const snapshotName = "symphony-test-base";
const dockerfilePath = new URL("../Dockerfile.snapshot", import.meta.url).pathname;
const snapshotDeadlineMs = 600_000;
const snapshotPollMs = 2_000;

class DaytonaTestSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaTestSnapshotError";
  }
}

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

const waitForActiveSnapshot = async (daytona: Daytona): Promise<void> => {
  const deadline = Date.now() + snapshotDeadlineMs;

  while (Date.now() < deadline) {
    const snapshot = await daytona.snapshot.get(snapshotName);
    if (snapshot.state === "active") {
      return;
    }
    if (snapshot.state === "error" || snapshot.state === "build_failed") {
      throw new DaytonaTestSnapshotError(
        `Snapshot ${snapshotName} is ${snapshot.state}: ${snapshot.errorReason ?? "unknown reason"}`,
      );
    }
    if (snapshot.state === "inactive") {
      await daytona.snapshot.activate(snapshot);
    }

    await sleep(snapshotPollMs);
  }

  throw new DaytonaTestSnapshotError(
    `Snapshot ${snapshotName} did not become active within ${snapshotDeadlineMs}ms`,
  );
};

export const ensureTestSnapshot = async (): Promise<void> => {
  await ensureStackUp();
  const daytona = makeDaytona();

  try {
    await daytona.snapshot.get(snapshotName);
    await waitForActiveSnapshot(daytona);
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
        entrypoint: ["/bin/bash"],
      },
      { timeout: 600 },
    );

    if (snapshot.state !== "active") {
      await waitForActiveSnapshot(daytona);
    }
  } catch (error) {
    if (error instanceof DaytonaTestSnapshotError) {
      throw error;
    }
    throw new DaytonaTestSnapshotError(
      `Failed to create Daytona test snapshot ${snapshotName}: ${describeUnknown(error)}`,
    );
  }
};
