import { Context, Effect, Layer } from "effect";

import { GitCommandError } from "./errors.js";
import { GitAdapter } from "./git.adapter.js";
import type { GithubCloneSourceHandoff } from "./models.js";
import { parseLsRemoteHead, validateGitBranchName, validateGitHubRepoUrl } from "./source.js";

export type GithubCloneSourceOptions = {
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly repoPath: string;
  readonly branchName: string;
  readonly githubToken?: string | undefined;
};

export type IntegrationServiceShape = {
  readonly prepareGithubCloneSourceHandoff: (
    options: GithubCloneSourceOptions,
  ) => Effect.Effect<GithubCloneSourceHandoff, GitCommandError>;
};

export class IntegrationService extends Context.Tag("IntegrationService")<
  IntegrationService,
  IntegrationServiceShape
>() {}

export const IntegrationServiceLive = Layer.effect(
  IntegrationService,
  Effect.gen(function* () {
    const git = yield* GitAdapter;

    return {
      prepareGithubCloneSourceHandoff: (options) =>
        Effect.gen(function* () {
          const repoUrl = yield* Effect.try({
            try: () => validateGitHubRepoUrl(options.repoUrl),
            catch: (error) =>
              new GitCommandError({
                command: ["git", "validate-repo-url"],
                stderr: error instanceof Error ? error.message : String(error),
                exitCode: -1,
              }),
          });
          const baseBranch = yield* Effect.try({
            try: () => validateGitBranchName(options.baseBranch),
            catch: (error) =>
              new GitCommandError({
                command: ["git", "validate-branch"],
                stderr: error instanceof Error ? error.message : String(error),
                exitCode: -1,
              }),
          });
          const stdout = yield* git.lsRemoteHead(repoUrl, baseBranch, options.githubToken);
          const baseSha = yield* Effect.try({
            try: () => parseLsRemoteHead(stdout, baseBranch),
            catch: (error) =>
              new GitCommandError({
                command: ["git", "ls-remote", "--heads", repoUrl, baseBranch],
                stderr: error instanceof Error ? error.message : String(error),
                exitCode: -1,
              }),
          });
          return {
            kind: "githubClone" as const,
            repoUrl,
            baseBranch,
            baseSha,
            repoPath: options.repoPath,
            branchName: options.branchName,
          };
        }),
    };
  }),
);
