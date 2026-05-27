import type { FpIssueDetail } from "../fp/models.js";

// Canonical sandbox path the orchestrator uploads the rendered prompt to. Mirrored from
// umbrella spec §"Source Handoff" step 4. The `Daytona.uploadFiles` call site reads this
// constant rather than hardcoding the path again.
export const WORKER_PROMPT_SANDBOX_PATH = "/tmp/prompt.md";

// Tempdir prefix used for the host-side rendered file.
export const WORKER_PROMPT_HOST_PREFIX = "swy-prompt-";

// Filename inside the per-render tempdir. The full host path is
// `<os.tmpdir()>/<prefix><random>/<filename>`.
export const WORKER_PROMPT_HOST_FILENAME = "prompt.md";

// Fallback prose substituted for the issue description when the underlying value is null,
// undefined (key absent), or whitespace-only. Actionable rather than a bare "(none)" so the
// worker has guidance even when the issue body is sparse.
export const MISSING_DESCRIPTION_FALLBACK =
  "(no issue description was provided; use the title and the workflow context to scope the work)";

export type WorkerPromptInput = {
  readonly issue: FpIssueDetail;
  readonly attempt: number;
  readonly source: {
    readonly kind: "githubClone";
    readonly repoUrl: string;
    readonly baseBranch: string;
    readonly baseSha: string;
    readonly repoPath: string;
    readonly branchName: string;
    readonly metadataPath: string;
    readonly runId: string;
    readonly sandboxId: string;
    readonly fpRestWorkdir: string;
  };
};

export type RenderedPrompt = {
  readonly content: string;
  // Absolute path to the rendered file on the host. The file lives inside a per-render
  // tempdir (`<os.tmpdir()>/swy-prompt-XXXX/prompt.md`); the caller cleans up by removing
  // `dirname(hostPath)`, not just the file, so the empty parent dir is not leaked.
  readonly hostPath: string;
  readonly sandboxPath: string;
};

// Closed shape the template substitution function consumes. Per-issue variable surface is
// intentionally small. Source instructions are rendered from the pinned GitHub clone metadata.
export type WorkerPromptVars = {
  readonly issueDisplayId: string;
  readonly issueTitle: string;
  readonly issueDescription: string;
  readonly sourceInstructions: string;
  readonly boundaryInstructions: string;
  readonly workInstructions: string;
  readonly outcomeInstructions: string;
  readonly outcomeBody: string;
  readonly summaryInstructions: string;
};
