import { describe, expect, test } from "bun:test";

import { SourceValidationError } from "../../src/integration/errors.js";
import {
  parseLsRemoteHead,
  validateGitBranchName,
  validateGitHubRepoUrl,
} from "../../src/integration/source.js";

describe("GitHub clone source validation", () => {
  test("accepts clean GitHub HTTPS repo URLs and normalizes trailing slash", () => {
    expect(validateGitHubRepoUrl("https://github.com/fiberplane/switchyard.git/")).toBe(
      "https://github.com/fiberplane/switchyard.git",
    );
  });

  test("rejects credentialed, unsupported, and shell-shaped repo URLs", () => {
    for (const repoUrl of [
      "https://token@github.com/fiberplane/switchyard.git",
      "ssh://github.com/fiberplane/switchyard.git",
      "https://example.com/fiberplane/switchyard.git",
      "https://github.com/fiberplane/switchyard.git;echo leaked",
      "https://github.com/.fiberplane/switchyard.git",
      "https://github.com/fiberplane/.switchyard.git",
      "https://github.com/fiberplane/switchyard.lock",
      "https://github.com/fiberplane/switch%79ard.git",
    ]) {
      expect(() => validateGitHubRepoUrl(repoUrl)).toThrow(SourceValidationError);
    }
  });

  test("validates branch names used in shell-rendered clone setup", () => {
    expect(validateGitBranchName("main")).toBe("main");
    for (const branch of [
      "-main",
      "feature/../main",
      "feature//main",
      "feature/.hidden",
      "feature/main.lock",
      "feature;echo leaked",
      "feature:bad",
      "feature^bad",
      "main@{1}",
    ]) {
      expect(() => validateGitBranchName(branch)).toThrow(SourceValidationError);
    }
  });

  test("parses ls-remote output for an exact branch ref", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(parseLsRemoteHead(`${sha}\trefs/heads/main\n`, "main")).toBe(sha);
  });
});
