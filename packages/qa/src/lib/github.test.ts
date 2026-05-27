import { runCommand } from "./command.test.js";
import type { RemoteE2EEnv } from "./env.test.js";

export type GithubPrInfo = {
  readonly url: string;
  readonly number: number;
  readonly body: string;
  readonly comments: readonly unknown[];
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly baseRefOid: string;
  readonly isDraft: boolean;
  readonly state: string;
};

export const repoFullName = (repoUrl: string): string => {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/u);
  if (match?.[1] === undefined) {
    throw new Error(`unsupported GitHub repo URL for E2E: ${repoUrl}`);
  }
  return match[1];
};

export const assertRemoteBaseBranch = async (env: RemoteE2EEnv): Promise<string> => {
  const result = await runCommand(
    "gh",
    ["api", `repos/${repoFullName(env.repoUrl)}/git/ref/heads/${env.baseBranch}`],
    {
      env: { ...process.env, GITHUB_TOKEN: env.host.github.token, GH_TOKEN: env.host.github.token },
    },
  );
  const payload = JSON.parse(result.stdout) as { readonly object?: { readonly sha?: unknown } };
  const sha = payload.object?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`remote base branch ${env.baseBranch} did not return a commit SHA`);
  }
  return sha;
};

export const assertGithubWriteAccess = async (
  env: RemoteE2EEnv,
  baseSha: string,
): Promise<void> => {
  const branch = `${env.allowedBranchPrefix.replace(/\/?$/u, "/")}preflight-${env.testRunId}`;
  const commandEnv = {
    ...process.env,
    GITHUB_TOKEN: env.host.github.token,
    GH_TOKEN: env.host.github.token,
  };
  let created = false;
  try {
    await runCommand(
      "gh",
      [
        "api",
        `repos/${repoFullName(env.repoUrl)}/git/refs`,
        "-X",
        "POST",
        "-f",
        `ref=refs/heads/${branch}`,
        "-f",
        `sha=${baseSha}`,
      ],
      { env: commandEnv },
    );
    created = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `remote Daytona E2E requires GITHUB_TOKEN/GH_TOKEN with contents read/write, workflows read/write, and pull requests read/write access to ${repoFullName(env.repoUrl)}; preflight branch creation failed: ${message}`,
    );
  } finally {
    if (created) {
      await runCommand(
        "gh",
        ["api", `repos/${repoFullName(env.repoUrl)}/git/refs/heads/${branch}`, "-X", "DELETE"],
        { env: commandEnv },
      );
    }
  }
};

export const viewPr = async (env: RemoteE2EEnv, prNumber: string): Promise<GithubPrInfo> => {
  const result = await runCommand(
    "gh",
    [
      "pr",
      "view",
      prNumber,
      "--repo",
      repoFullName(env.repoUrl),
      "--comments",
      "--json",
      "url,number,body,comments,headRefName,headRefOid,baseRefOid,isDraft,state",
    ],
    {
      env: { ...process.env, GITHUB_TOKEN: env.host.github.token, GH_TOKEN: env.host.github.token },
    },
  );
  return JSON.parse(result.stdout) as GithubPrInfo;
};

const deleteRemoteBranch = async (env: RemoteE2EEnv, branch: string): Promise<void> => {
  if (!branch.startsWith(env.allowedBranchPrefix)) {
    throw new Error(`cleanup refused branch outside allowed prefix: ${branch}`);
  }
  const commandEnv = {
    ...process.env,
    GITHUB_TOKEN: env.host.github.token,
    GH_TOKEN: env.host.github.token,
  };
  await runCommand(
    "gh",
    ["api", `repos/${repoFullName(env.repoUrl)}/git/refs/heads/${branch}`, "-X", "DELETE"],
    { env: commandEnv },
  ).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("HTTP 404")) {
      return;
    }
    throw error;
  });
};

export const cleanupPrAndBranch = async (
  env: RemoteE2EEnv,
  prNumber: string | undefined,
  branch: string | undefined,
): Promise<void> => {
  if (env.keep || branch === undefined) {
    return;
  }
  if (prNumber === undefined) {
    await deleteRemoteBranch(env, branch);
    return;
  }
  let pr: GithubPrInfo;
  try {
    pr = await viewPr(env, prNumber);
  } catch (error) {
    try {
      await deleteRemoteBranch(env, branch);
    } catch (deleteError) {
      throw new AggregateError([error, deleteError], `cleanup failed for PR ${prNumber}`);
    }
    throw error;
  }
  if (pr.headRefName !== branch) {
    throw new Error(
      `cleanup refused PR ${prNumber}: head ${pr.headRefName} did not match ${branch}`,
    );
  }
  await runCommand(
    "gh",
    ["pr", "close", prNumber, "--repo", repoFullName(env.repoUrl), "--delete-branch"],
    {
      env: {
        ...process.env,
        GITHUB_TOKEN: env.host.github.token,
        GH_TOKEN: env.host.github.token,
      },
    },
  ).catch(async () => {
    await deleteRemoteBranch(env, branch);
  });
};
