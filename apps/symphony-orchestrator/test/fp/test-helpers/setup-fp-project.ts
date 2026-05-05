import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeContext } from "@effect/platform-node";
import { Data, Effect } from "effect";

import { FpBinary, FpBinaryLive } from "../../../src/fp/binary.js";

export class FpTestCommandError extends Data.TaggedError("FpTestCommandError")<{
  readonly command: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  get message(): string {
    return `fp test command failed in ${this.cwd}: ${this.command.join(" ")} (exit code ${this.exitCode})\n${this.stderr}`;
  }
}

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

const resolveRealFpBinary = (): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fpBinary = yield* FpBinary;
      return yield* fpBinary.resolve();
    }).pipe(Effect.provide(FpBinaryLive()), Effect.provide(NodeContext.layer)),
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
    throw new FpTestCommandError({
      command: [project.fpPath, ...args],
      cwd: project.projectDir,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result.stdout;
};

export const setupFpProject = async (): Promise<FpTestProject> => {
  const fpPath = await resolveRealFpBinary();
  const projectDir = await mkdtemp(join(tmpdir(), "swy-fp-"));
  const homeDir = await mkdtemp(join(tmpdir(), "swy-fp-home-"));
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
      Promise.all([
        rm(projectDir, { force: true, recursive: true }),
        rm(homeDir, { force: true, recursive: true }),
      ]).then(() => undefined),
  };

  await runFpSuccess(project, ["init", "--prefix", "SWY", "--yes", "--agent", "skip"]);
  await copyFile(
    symphonyStateExtensionPath,
    join(projectDir, ".fp", "extensions", "symphony-state.ts"),
  );

  return project;
};
