// Canonical sandbox paths owned by this module. Aligned with the umbrella spec
// (§"Source Handoff", §"Artifact Collection") so the orchestrator + worker prompt
// + artifact downloader all agree on the contract.
export const SANDBOX_REPO_PATH = "/workspace/repo";
export const SANDBOX_SYMPHONY_DIR = "/tmp/.symphony";
export const SANDBOX_ARCHIVE_PATH = "/tmp/repo.tgz";
export const SANDBOX_BUNDLE_PATH = "/tmp/.symphony/work.bundle";

// Stable, non-routable identity stamped onto the in-sandbox base commit. See
// ADR D6: the sandbox always has a single-commit history rooted at this tag,
// so future history-reading tools see deterministic author metadata.
export const SANDBOX_GIT_AUTHOR_NAME = "Symphony Sandbox";
export const SANDBOX_GIT_AUTHOR_EMAIL = "symphony-sandbox@switchyard.local";

export type SetupRepoOptions = {
  readonly archivePath: string;
  readonly repoPath: string;
  readonly symphonyDir: string;
};

export type FinalizeBundleOptions = {
  readonly repoPath: string;
  readonly bundlePath: string;
};

export type SandboxBundleResult = {
  readonly bundlePath: string;
  readonly commitsBeyondBase: number;
};

export type SandboxScriptOperation = "setupRepo" | "finalizeBundle";
