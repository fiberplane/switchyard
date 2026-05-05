import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FpCommandError } from "../../../src/fp/errors.js";

export type FpTestProject = {
  readonly projectDir: string;
  readonly homeDir: string;
  readonly fpPath: string;
  readonly env: Record<string, string | undefined>;
  readonly cleanup: () => Promise<void>;
};

export type FpCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

const symphonyStateExtensionPath = fileURLToPath(
  new URL("../../../../../.fp/extensions/symphony-state.ts", import.meta.url),
);

export const runFpCommand = async (
  project: FpTestProject,
  args: readonly string[],
): Promise<FpCommandResult> => {
  const proc = Bun.spawn([project.fpPath, ...args], {
    cwd: project.projectDir,
    env: project.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
};

export const runFpSuccess = async (
  project: FpTestProject,
  args: readonly string[],
): Promise<string> => {
  const result = await runFpCommand(project, args);
  if (result.exitCode !== 0) {
    throw new FpCommandError({
      command: [project.fpPath, ...args],
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result.stdout;
};

const makeTempDirectory = async (template: string): Promise<string> =>
  (await Bun.$`mktemp -d ${template}`.text()).trim();

export const setupFpProject = async (fpPath: string): Promise<FpTestProject> => {
  const projectDir = await makeTempDirectory("/tmp/swy-fp-XXXXXXXX");
  const homeDir = await makeTempDirectory("/tmp/swy-fp-home-XXXXXXXX");
  const env = {
    ...process.env,
    HOME: homeDir,
    SWITCHYARD_FP_BIN: fpPath,
  };
  const project: FpTestProject = {
    projectDir,
    homeDir,
    fpPath,
    env,
    cleanup: () =>
      Promise.all([Bun.$`rm -rf ${projectDir}`, Bun.$`rm -rf ${homeDir}`]).then(() => undefined),
  };

  await runFpSuccess(project, ["init", "--prefix", "SWY", "--yes", "--agent", "skip"]);
  await Bun.$`cp ${symphonyStateExtensionPath} ${join(projectDir, ".fp", "extensions", "symphony-state.ts")}`;

  return project;
};
