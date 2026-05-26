import { join } from "node:path";

import { Error as PlatformError, FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";

import { WorkerPromptWriteError, type WorkerPromptError } from "./errors.js";
import {
  MISSING_DESCRIPTION_FALLBACK,
  WORKER_PROMPT_HOST_FILENAME,
  WORKER_PROMPT_HOST_PREFIX,
  WORKER_PROMPT_SANDBOX_PATH,
  type RenderedPrompt,
  type WorkerPromptInput,
  type WorkerPromptVars,
} from "./models.js";
import { WORKER_PROMPT_TEMPLATE, renderTemplate } from "./template.js";

export type WorkerPromptServiceShape = {
  readonly renderPrompt: (
    input: WorkerPromptInput,
  ) => Effect.Effect<RenderedPrompt, WorkerPromptError, FileSystem.FileSystem>;
};

export class WorkerPromptService extends Context.Tag("WorkerPromptService")<
  WorkerPromptService,
  WorkerPromptServiceShape
>() {}

const resolveDescription = (raw: string | null | undefined): string => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return MISSING_DESCRIPTION_FALLBACK;
  }
  return raw;
};

const sourceInstructions = (input: WorkerPromptInput): string => {
  if (input.source.kind === "archive") {
    return [
      `- The local repo is \`${input.source.repoPath}\`. Start there.`,
      `- \`${input.source.repoPath}\` mirrors the host repository root. Treat all file paths as host`,
      "  repo-relative paths (for example, edit `apps/symphony-orchestrator/test/...` for",
      "  orchestrator tests, not top-level `test/...`).",
      "- The starting commit is tagged `symphony-base`. Make your changes on top of it.",
    ].join("\n");
  }

  return [
    `- The local repo is \`${input.source.repoPath}\`. Start there.`,
    `- The repo was cloned from \`${input.source.repoUrl}\` and checked out at pinned base SHA \`${input.source.baseSha}\` from \`${input.source.baseBranch}\`.`,
    `- Clone metadata is available at \`${input.source.metadataPath}\` as JSON, including the deterministic worker branch \`${input.source.branchName}\`.`,
    `- This run id is \`${input.source.runId}\`; the Daytona sandbox id is \`${input.source.sandboxId}\`.`,
    "- Leave `origin` credential-free; GitHub access is provided through `GH_TOKEN`/`GITHUB_TOKEN` plus `GIT_ASKPASS` in the worker process environment.",
  ].join("\n");
};

const boundaryInstructions = (input: WorkerPromptInput): string => {
  if (input.source.kind === "archive") {
    return [
      "- You have **no `fp` credentials**. Do not attempt `fp` writes; the orchestrator owns all `fp` state.",
      "- You do not need to contact the host machine. Outcome flows entirely through files in the sandbox; the orchestrator collects them after your turn ends. **No host base URL is provided.**",
      "- Do **not** file follow-up issues yourself. Worker-driven follow-up filing is deferred. Put any out-of-scope observations or follow-up suggestions in your `summary` (see below) as prose.",
    ].join("\n");
  }

  return [
    "- You own durable task state after the orchestrator handoff. Use `fp` from a non-repo workdir with the REST remote, then use `gh` to open and babysit the PR.",
    `- Run fp commands from \`${input.source.fpRestWorkdir}\`, not from the cloned repository. The worker environment provides \`FP_REMOTE=rest-api\`, \`FP_TOKEN\`, \`FP_SERVER_URL\`, \`FP_WORKSPACE\`, and \`FP_PROJECT_ID\` when configured.`,
    "- Do not run `gh auth login`. Use the provided `GH_TOKEN`/`GITHUB_TOKEN` environment variables. If you must isolate gh config, create a temporary `GH_CONFIG_DIR` and remove it before diagnostics.",
    "- Do not write credentials to repo files, shell profiles, fp comments, PR bodies, logs, transcripts, or diagnostics.",
  ].join("\n");
};

const workInstructions = (input: WorkerPromptInput): string => {
  if (input.source.kind === "archive") {
    return [
      "- Make code changes in the repo.",
      "- Cadence: **commit early, commit often**, with descriptive commit messages — the orchestrator will preserve your full commit history via `git bundle`, and the human reviewer reads commit messages to understand your reasoning. Prefer multiple small commits over one squash.",
      "- You may run any commands you need to validate your work (build, test, type-check). The output of those commands does **not** need to be persisted; the orchestrator does not validate or re-run them.",
    ].join("\n");
  }

  return [
    `- Create or reset local branch \`${input.source.branchName}\` from pinned base SHA \`${input.source.baseSha}\`, then make the requested changes there.`,
    "- Follow the repo's fp workflow: inspect context, comment useful milestones, implement, verify, request an adversarial review, address findings, and keep commits associated with the fp issue.",
    "- Push the branch to GitHub with git using `GIT_ASKPASS`; do not put tokens in the remote URL.",
    "- Open a non-draft PR with `gh pr create`, then babysit checks and review comments until the PR is in a reviewable state.",
    "- Set fp custom properties as soon as values are known: `symphony_branch`, `symphony_pr_url`, `symphony_pr_number`, `symphony_base_sha`, `symphony_head_sha`, `symphony_run_id`, and `symphony_sandbox_id`.",
    "- Record clear verification evidence in fp comments and the PR body. Keep all credentials out of those texts.",
  ].join("\n");
};

const outcomeInstructions = (input: WorkerPromptInput): string =>
  input.source.kind === "archive"
    ? "**Before producing your final assistant message / exiting the turn**, you MUST write `/tmp/.symphony/outcome.json` with this exact shape and no extra fields:"
    : "**Before producing your final assistant message / exiting the turn**, you MUST leave the durable state in fp and GitHub: pushed branch, PR URL/number, head SHA, and the canonical `symphony_*` properties. Do not write an orchestrator return artifact.";

const outcomeBody = (input: WorkerPromptInput): string =>
  input.source.kind === "archive"
    ? [
        "```json",
        "{",
        '  "status": "completed" | "blocked" | "needs-human" | "failed",',
        '  "summary": "<markdown narrative — what you did, why, and any caveats>"',
        "}",
        "```",
        "",
        "Pick `status` deliberately:",
        "",
        '- `"completed"` only if you believe the work is fully done and ready for a human to review the resulting branch.',
        '- `"blocked"` if a precondition you cannot satisfy stops you.',
        '- `"needs-human"` if the work is partially done but you are uncertain.',
        '- `"failed"` if you tried and could not produce useful output.',
      ].join("\n")
    : [
        "Required durable fields:",
        "",
        `- \`symphony_branch\`: \`${input.source.branchName}\``,
        "- `symphony_pr_url`: the GitHub PR URL",
        "- `symphony_pr_number`: the GitHub PR number as text",
        `- \`symphony_base_sha\`: \`${input.source.baseSha}\``,
        "- `symphony_head_sha`: the pushed branch HEAD SHA",
        `- \`symphony_run_id\`: \`${input.source.runId}\``,
        `- \`symphony_sandbox_id\`: \`${input.source.sandboxId}\``,
      ].join("\n");

const summaryInstructions = (input: WorkerPromptInput): string =>
  input.source.kind === "archive"
    ? "The `summary` becomes the fp comment narrative attached to this issue. Include any out-of-scope observations or follow-up suggestions there as prose."
    : "Your final assistant message should summarize the PR URL, fp property writes, verification, and any remaining babysitting state. Do not include secrets.";

const mapWriteError = (path: string) => (error: PlatformError.PlatformError) =>
  new WorkerPromptWriteError({
    path,
    reason: error.message,
  });

const renderPromptImpl = (
  input: WorkerPromptInput,
): Effect.Effect<RenderedPrompt, WorkerPromptError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    // `satisfies WorkerPromptVars` enforces the closed shape while the value still flows
    // into `renderTemplate`'s wider `Record<string, string>` parameter.
    const vars = {
      issueDisplayId: input.issue.displayId,
      issueTitle: input.issue.title,
      issueDescription: resolveDescription(input.issue.description),
      sourceInstructions: sourceInstructions(input),
      boundaryInstructions: boundaryInstructions(input),
      workInstructions: workInstructions(input),
      outcomeInstructions: outcomeInstructions(input),
      outcomeBody: outcomeBody(input),
      summaryInstructions: summaryInstructions(input),
    } satisfies WorkerPromptVars;

    const content = yield* renderTemplate(WORKER_PROMPT_TEMPLATE, vars);

    // Caller owns host-side cleanup of `dirname(hostPath)`. Mirrors
    // `IntegrationService.prepareSourceHandoff`'s tempdir pattern: per-render directory
    // under the OS tmpdir, returned path lives until the orchestrator deletes it after
    // `daytona.uploadFiles` completes.
    const dir = yield* fs
      .makeTempDirectory({ prefix: WORKER_PROMPT_HOST_PREFIX })
      .pipe(Effect.mapError(mapWriteError(`<tmpdir>/${WORKER_PROMPT_HOST_PREFIX}*`)));

    const hostPath = join(dir, WORKER_PROMPT_HOST_FILENAME);
    yield* fs.writeFileString(hostPath, content).pipe(Effect.mapError(mapWriteError(hostPath)));

    return {
      content,
      hostPath,
      sandboxPath: WORKER_PROMPT_SANDBOX_PATH,
    };
  }).pipe(
    Effect.withSpan("WorkerPromptService.renderPrompt", {
      attributes: {
        issue_id: input.issue.id,
        issue_display_id: input.issue.displayId,
        attempt: input.attempt,
      },
    }),
  );

export const WorkerPromptServiceLive = Layer.succeed(WorkerPromptService, {
  renderPrompt: renderPromptImpl,
});
