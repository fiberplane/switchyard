import { SourceValidationError } from "./errors.js";

const shellMetacharacterPattern = /[`$&|;<>(){}[\]*?!~"'\\]/u;
const gitRefForbiddenPattern = /[:^]/u;
const whitespacePattern = /\s/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const githubOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const githubRepoPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\.git)?$/u;

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((char) => {
    const code = char.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });

export const validateGitHubRepoUrl = (repoUrl: string): string => {
  if (
    hasControlCharacter(repoUrl) ||
    whitespacePattern.test(repoUrl) ||
    shellMetacharacterPattern.test(repoUrl)
  ) {
    throw new SourceValidationError({
      field: "repoUrl",
      reason: "must not contain control characters or shell metacharacters",
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new SourceValidationError({ field: "repoUrl", reason: "must be an absolute URL" });
  }

  if (parsed.protocol !== "https:") {
    throw new SourceValidationError({ field: "repoUrl", reason: "must use https" });
  }
  if (parsed.hostname !== "github.com") {
    throw new SourceValidationError({ field: "repoUrl", reason: "must target github.com" });
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new SourceValidationError({
      field: "repoUrl",
      reason: "must not embed credentials",
    });
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new SourceValidationError({
      field: "repoUrl",
      reason: "must not include query strings or fragments",
    });
  }

  if (parsed.pathname.includes("%")) {
    throw new SourceValidationError({
      field: "repoUrl",
      reason: "must not include percent-encoded path segments",
    });
  }

  const path = parsed.pathname.replace(/\/+$/u, "");
  const parts = path.split("/").filter((part) => part.length > 0);
  const [owner, repo] = parts;
  if (
    parts.length !== 2 ||
    owner === undefined ||
    repo === undefined ||
    !githubOwnerPattern.test(owner) ||
    !githubRepoPattern.test(repo) ||
    repo.startsWith(".") ||
    repo.endsWith(".") ||
    repo.endsWith(".lock") ||
    repo.includes("..")
  ) {
    throw new SourceValidationError({
      field: "repoUrl",
      reason: "must look like https://github.com/<owner>/<repo>.git",
    });
  }

  return `https://github.com${path}`;
};

export const validateGitBranchName = (baseBranch: string): string => {
  if (
    baseBranch.length === 0 ||
    baseBranch.startsWith("-") ||
    baseBranch.endsWith("/") ||
    baseBranch.endsWith(".") ||
    baseBranch.includes("..") ||
    baseBranch.includes("//") ||
    baseBranch.includes("@{") ||
    baseBranch
      .split("/")
      .some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock")) ||
    hasControlCharacter(baseBranch) ||
    whitespacePattern.test(baseBranch) ||
    shellMetacharacterPattern.test(baseBranch) ||
    gitRefForbiddenPattern.test(baseBranch)
  ) {
    throw new SourceValidationError({
      field: "baseBranch",
      reason: "must be a simple git branch name without shell metacharacters",
    });
  }
  return baseBranch;
};

export const parseLsRemoteHead = (stdout: string, baseBranch: string): string => {
  const expectedRef = `refs/heads/${baseBranch}`;
  const line = stdout.split(/\r?\n/u).find((entry) => entry.trim().endsWith(`\t${expectedRef}`));
  const sha = line?.split(/\s+/u)[0];
  if (sha === undefined || !shaPattern.test(sha)) {
    throw new SourceValidationError({
      field: "baseBranch",
      reason: `remote branch ${baseBranch} was not found`,
    });
  }
  return sha;
};
