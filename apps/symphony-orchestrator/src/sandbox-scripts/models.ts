// Canonical sandbox paths owned by this module. The active remote path clones
// GitHub source into the repo path and keeps orchestration metadata outside the repo.
export const SANDBOX_REPO_PATH = "/workspace/repo";
export const SANDBOX_SYMPHONY_DIR = "/tmp/.symphony";

// Stable, non-routable identity used for in-sandbox worker git commits.
export const SANDBOX_GIT_AUTHOR_NAME = "Symphony Sandbox";
export const SANDBOX_GIT_AUTHOR_EMAIL = "symphony-sandbox@switchyard.local";

export type SetupCloneOptions = {
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly repoPath: string;
  readonly branchName: string;
  readonly symphonyDir: string;
  readonly githubToken?: string | undefined;
};

export type SandboxScriptOperation = "setupClone";
