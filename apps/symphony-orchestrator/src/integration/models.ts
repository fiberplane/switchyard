export const SYMPHONY_BRANCH_PREFIX = "symphony";

export type ArchiveSourceHandoff = {
  readonly kind: "archive";
  readonly baseRev: string;
  readonly archivePath: string;
};

export type GithubCloneSourceHandoff = {
  readonly kind: "githubClone";
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly repoPath: string;
  readonly branchName: string;
};

export type SourceHandoff = ArchiveSourceHandoff | GithubCloneSourceHandoff;

export type IntegrationResult = {
  readonly branch: string;
  readonly commitsBeyondBase: number;
  readonly attempt: number;
};

export const sourceBaseRev = (handoff: SourceHandoff): string =>
  handoff.kind === "archive" ? handoff.baseRev : handoff.baseSha;

export const symphonyRefspec = (issueId: string, suffix?: string): string => {
  const refName = suffix === undefined ? issueId : `${issueId}-${suffix}`;
  return `+HEAD:refs/${SYMPHONY_BRANCH_PREFIX}/${refName}`;
};

export const symphonyRefName = (issueId: string, suffix?: string): string => {
  const base = suffix === undefined ? issueId : `${issueId}-${suffix}`;
  return `refs/${SYMPHONY_BRANCH_PREFIX}/${base}`;
};

export const symphonyBranchName = (issueId: string, attempt: number, suffix?: string): string => {
  const suffixed = suffix === undefined ? issueId : `${issueId}-${suffix}`;
  const withAttempt = attempt === 1 ? suffixed : `${suffixed}-attempt${attempt}`;
  return `${SYMPHONY_BRANCH_PREFIX}/${withAttempt}`;
};
