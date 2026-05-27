export const SYMPHONY_BRANCH_PREFIX = "symphony";

export type GithubCloneSourceHandoff = {
  readonly kind: "githubClone";
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly repoPath: string;
  readonly branchName: string;
};

export const symphonyBranchName = (issueId: string, attempt: number, suffix?: string): string => {
  const suffixed = suffix === undefined ? issueId : `${issueId}-${suffix}`;
  const withAttempt = attempt === 1 ? suffixed : `${suffixed}-attempt${attempt}`;
  return `${SYMPHONY_BRANCH_PREFIX}/${withAttempt}`;
};
