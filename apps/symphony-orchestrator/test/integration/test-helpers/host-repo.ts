import { join } from "node:path";

import { GitCommandError } from "../../../src/integration/errors.js";

export type HostRepo = {
  readonly dir: string;
  readonly env: Record<string, string | undefined>;
  readonly cleanup: () => Promise<void>;
};

const gitEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
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

export const setupHostRepo = async (): Promise<HostRepo> => {
  const dir = await mkdtemp("/tmp/swy-git-host-XXXXXXXX");
  const env = gitEnv();
  await runGit(dir, env, ["init", "--initial-branch=main", "--quiet"]);
  await Bun.write(join(dir, "README.md"), "# host repo\n");
  await Bun.write(join(dir, "src.ts"), "export const x = 1;\n");
  await runGit(dir, env, ["add", "."]);
  await runGit(dir, env, ["commit", "-m", "initial commit", "--quiet"]);
  return {
    dir,
    env,
    cleanup: async () => {
      await Bun.$`rm -rf ${dir}`;
    },
  };
};

export const headSha = async (repoDir: string): Promise<string> => {
  const env = gitEnv();
  const out = await runGit(repoDir, env, ["rev-parse", "HEAD"]);
  return out.trim();
};

export const branchExistsRaw = async (repoDir: string, name: string): Promise<boolean> => {
  const env = gitEnv();
  const proc = Bun.spawn(["git", "show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
    cwd: repoDir,
    env,
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
};

export const gitLogSubjects = async (repoDir: string, ref: string): Promise<string[]> => {
  const env = gitEnv();
  const out = await runGit(repoDir, env, ["log", ref, "--format=%s"]);
  return out
    .trim()
    .split("\n")
    .filter((line) => line !== "");
};

export const revListCount = async (repoDir: string, range: string): Promise<number> => {
  const env = gitEnv();
  const out = await runGit(repoDir, env, ["rev-list", "--count", range]);
  return Number(out.trim());
};
