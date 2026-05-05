import { join } from "node:path";

import { GitCommandError } from "../../../src/integration/errors.js";

export type SandboxRepo = {
  readonly dir: string;
  readonly env: Record<string, string | undefined>;
  readonly cleanup: () => Promise<void>;
};

const gitEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Worker",
  GIT_AUTHOR_EMAIL: "worker@example.com",
  GIT_COMMITTER_NAME: "Worker",
  GIT_COMMITTER_EMAIL: "worker@example.com",
});

const mkdtemp = async (template: string): Promise<string> =>
  (await Bun.$`mktemp -d ${template}`.text()).trim();

const runGit = async (cwd: string, env: Record<string, string | undefined>, args: string[]) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new GitCommandError({
      command: ["git", ...args],
      stderr: `cwd=${cwd}: ${stderr}`,
      exitCode,
    });
  }
  return stdout;
};

export const setupSandboxRepo = async (): Promise<SandboxRepo> => {
  const dir = await mkdtemp("/tmp/swy-git-sbox-XXXXXXXX");
  const env = gitEnv();
  await runGit(dir, env, ["init", "--initial-branch=main", "--quiet"]);
  await Bun.write(join(dir, "src.ts"), "export const x = 1;\n");
  await runGit(dir, env, ["add", "."]);
  await runGit(dir, env, ["commit", "-m", "base", "--quiet"]);
  await runGit(dir, env, ["tag", "symphony-base"]);
  return {
    dir,
    env,
    cleanup: async () => {
      await Bun.$`rm -rf ${dir}`;
    },
  };
};

export const sandboxAddCommit = async (
  sandbox: SandboxRepo,
  filename: string,
  contents: string,
  subject: string,
): Promise<void> => {
  await Bun.write(join(sandbox.dir, filename), contents);
  await runGit(sandbox.dir, sandbox.env, ["add", "."]);
  await runGit(sandbox.dir, sandbox.env, ["commit", "-m", subject, "--quiet"]);
};

export const sandboxCreateBundle = async (
  sandbox: SandboxRepo,
  range: string,
  outputPath: string,
): Promise<void> => {
  await runGit(sandbox.dir, sandbox.env, ["bundle", "create", outputPath, range, "--quiet"]);
};
