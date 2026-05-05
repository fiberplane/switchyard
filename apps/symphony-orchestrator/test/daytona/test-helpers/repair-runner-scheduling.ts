import { DaytonaRunnerRepairError } from "./errors.js";

const projectName = "switchyard-test";
const dbContainer = `${projectName}-db-1`;

const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (stream === null) {
    return "";
  }
  return await new Response(stream).text();
};

export const repairRunnerSchedulingIfEnabled = async (target: string): Promise<boolean> => {
  if (process.env.SWITCHYARD_DAYTONA_REPAIR_RUNNER !== "1") {
    return false;
  }

  // Local Daytona OSS on some hosts can leave the default runner with stale scheduling
  // metrics, which surfaces as "No available runners" during snapshot or sandbox create.
  const sql = [
    "update runner",
    'set "availabilityScore"=100, "currentDiskUsagePercentage"=50',
    `where region='${target}' and state='ready' and draining=false;`,
  ].join(" ");
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      dbContainer,
      "psql",
      "-U",
      "user",
      "-d",
      "daytona",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    readStream(proc.stdout),
    readStream(proc.stderr),
  ]);

  if (exitCode !== 0) {
    throw new DaytonaRunnerRepairError({
      reason: [
        `Runner scheduling repair failed for Daytona test stack '${projectName}'.`,
        "stdout:",
        stdout.trim(),
        "stderr:",
        stderr.trim(),
      ].join("\n"),
    });
  }

  return true;
};
