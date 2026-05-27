import { Either, Schema } from "effect";

import { runCommand } from "./command.test.js";
import type { RemoteE2EEnv } from "./env.test.js";

const GitRefSchema = Schema.Struct({
  object: Schema.Struct({
    sha: Schema.String,
  }),
});

const GithubPrInfoSchema = Schema.Struct({
  url: Schema.String,
  number: Schema.Number,
  body: Schema.String,
  comments: Schema.Array(Schema.Unknown),
  headRefName: Schema.String,
  headRefOid: Schema.String,
  baseRefOid: Schema.String,
  isDraft: Schema.Boolean,
  state: Schema.String,
});

export type GithubPrInfo = Schema.Schema.Type<typeof GithubPrInfoSchema>;

const GithubRestPullSchema = Schema.Struct({
  html_url: Schema.String,
  number: Schema.Number,
  body: Schema.NullOr(Schema.String),
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
  }),
  base: Schema.Struct({
    sha: Schema.String,
  }),
  draft: Schema.Boolean,
  state: Schema.String,
});

const decodeJson = <A, I>(
  schema: Schema.Schema<A, I, never>,
  content: string,
  label: string,
): A => {
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(schema))(content);
  if (Either.isLeft(decoded)) {
    throw new Error(`${label} response did not match expected schema`);
  }
  return decoded.right;
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
  const payload = decodeJson(GitRefSchema, result.stdout, "github ref");
  const sha = payload.object.sha;
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
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
  const commandEnv = {
    ...process.env,
    GITHUB_TOKEN: env.host.github.token,
    GH_TOKEN: env.host.github.token,
  };
  const repo = repoFullName(env.repoUrl);
  const prResult = await runCommand("gh", ["api", `repos/${repo}/pulls/${prNumber}`], {
    env: commandEnv,
  });
  const commentsResult = await runCommand(
    "gh",
    ["api", `repos/${repo}/issues/${prNumber}/comments`],
    { env: commandEnv },
  );
  const pr = decodeJson(GithubRestPullSchema, prResult.stdout, "github pr");
  const comments = decodeJson(
    Schema.Array(Schema.Unknown),
    commentsResult.stdout,
    "github comments",
  );
  return {
    url: pr.html_url,
    number: pr.number,
    body: pr.body ?? "",
    comments,
    headRefName: pr.head.ref,
    headRefOid: pr.head.sha,
    baseRefOid: pr.base.sha,
    isDraft: pr.draft,
    state: pr.state.toUpperCase(),
  };
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
