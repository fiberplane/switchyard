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
  return [
    `- The local repo is \`${input.source.repoPath}\`. Start there.`,
    `- The repo was cloned from \`${input.source.repoUrl}\` and checked out at pinned base SHA \`${input.source.baseSha}\` from \`${input.source.baseBranch}\`.`,
    `- Clone metadata is available at \`${input.source.metadataPath}\` as JSON, including the deterministic worker branch \`${input.source.branchName}\`.`,
    `- This run id is \`${input.source.runId}\`; the Daytona sandbox id is \`${input.source.sandboxId}\`.`,
    "- Leave `origin` credential-free; GitHub access is provided through `GH_TOKEN`/`GITHUB_TOKEN` plus `GIT_ASKPASS` in the worker process environment.",
  ].join("\n");
};

const boundaryInstructions = (input: WorkerPromptInput): string => {
  return [
    "- You own durable task state after the orchestrator handoff. Use `fp` from a non-repo workdir with the REST remote, then use `gh` to open and babysit the PR.",
    `- Run fp commands from \`${input.source.fpRestWorkdir}\`, not from the cloned repository. The worker environment provides \`FP_REMOTE=rest-api\`, \`FP_TOKEN\`, \`FP_SERVER_URL\`, \`FP_WORKSPACE\`, and \`FP_PROJECT_ID\` when configured.`,
    "- Do not run `gh auth login`. Use the provided `GH_TOKEN`/`GITHUB_TOKEN` environment variables. If you must isolate gh config, create a temporary `GH_CONFIG_DIR` and remove it before diagnostics.",
    "- Do not write credentials to repo files, shell profiles, fp comments, PR bodies, logs, transcripts, or diagnostics.",
  ].join("\n");
};

const workInstructions = (input: WorkerPromptInput): string => {
  return [
    `- Create or reset local branch \`${input.source.branchName}\` from pinned base SHA \`${input.source.baseSha}\`, then make the requested changes there.`,
    "- Follow the repo's fp workflow: inspect context, comment useful milestones, implement, verify, request an adversarial review, address findings, and keep commits associated with the fp issue.",
    "- Push the branch to GitHub with git using `GIT_ASKPASS`; do not put tokens in the remote URL.",
    `- Open a non-draft PR against base branch \`${input.source.baseBranch}\` with \`gh pr create --base ${input.source.baseBranch} --head ${input.source.branchName}\`, then babysit checks and review comments until the PR is in a reviewable state.`,
    "- Set fp custom properties as soon as values are known: `symphony_branch`, `symphony_pr_url`, `symphony_pr_number`, `symphony_base_sha`, `symphony_head_sha`, `symphony_run_id`, and `symphony_sandbox_id`.",
    `- When the PR and verification are ready, mark issue \`${input.issue.displayId}\` done with \`symphony_state=end\` in the same fp update that records final metadata.`,
    "- Record clear verification evidence in fp comments and the PR body. Keep all credentials out of those texts.",
  ].join("\n");
};

const outcomeInstructions = (): string =>
  "**Before producing your final assistant message / exiting the turn**, you MUST leave the durable state in fp and GitHub: pushed branch, PR URL/number, head SHA, and the canonical `symphony_*` properties. Do not write an orchestrator return artifact.";

const outcomeBody = (input: WorkerPromptInput): string =>
  [
    "Required durable fields:",
    "",
    `- \`symphony_branch\`: \`${input.source.branchName}\``,
    "- `symphony_pr_url`: the GitHub PR URL",
    "- `symphony_pr_number`: the GitHub PR number as text",
    `- \`symphony_base_sha\`: \`${input.source.baseSha}\``,
    "- `symphony_head_sha`: the pushed branch HEAD SHA",
    `- \`symphony_run_id\`: \`${input.source.runId}\``,
    `- \`symphony_sandbox_id\`: \`${input.source.sandboxId}\``,
    `- fp issue \`${input.issue.displayId}\`: \`status=done\` and \`symphony_state=end\``,
  ].join("\n");

const summaryInstructions = (): string =>
  "Your final assistant message should summarize the PR URL, fp property writes, verification, and any remaining babysitting state. Do not include secrets.";

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
      outcomeInstructions: outcomeInstructions(),
      outcomeBody: outcomeBody(input),
      summaryInstructions: summaryInstructions(),
    } satisfies WorkerPromptVars;

    const content = yield* renderTemplate(WORKER_PROMPT_TEMPLATE, vars);

    // Caller owns host-side cleanup of `dirname(hostPath)`. The per-render directory
    // lives under the OS tmpdir until the orchestrator deletes it after upload.
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
