import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
};

export const runCommand = async (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CommandResult> => {
  const commandFile =
    file === "fp" &&
    options.env?.SWITCHYARD_FP_BIN !== undefined &&
    options.env.SWITCHYARD_FP_BIN !== ""
      ? options.env.SWITCHYARD_FP_BIN
      : file;
  const result = await execFileAsync(commandFile, [...args], {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 1024 * 1024 * 20,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};
