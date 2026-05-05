import { listTestSandboxes } from "./stack.js";

const orphanAgeMs = 6 * 60 * 60 * 1000;

const describeUnknown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const warn = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

export const sweepOrphanedTestSandboxes = async (): Promise<void> => {
  try {
    const cutoff = Date.now() - orphanAgeMs;
    const sandboxes = await listTestSandboxes();
    const orphaned = sandboxes.filter((sandbox) => {
      const createdAtMs = Number(sandbox.labels.created_at_ms);
      return Number.isFinite(createdAtMs) && createdAtMs < cutoff;
    });

    const results = await Promise.allSettled(orphaned.map((sandbox) => sandbox.delete(120)));
    for (const result of results) {
      if (result.status === "rejected") {
        warn(`Daytona orphan sandbox cleanup failed: ${describeUnknown(result.reason)}`);
      }
    }
  } catch (error) {
    warn(`Daytona orphan sandbox sweep skipped: ${describeUnknown(error)}`);
  }
};
