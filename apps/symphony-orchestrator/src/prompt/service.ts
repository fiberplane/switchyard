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
    "- Leave `origin` credential-free; clone credentials were process-scoped by the orchestrator.",
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
    "- This is the temporary `githubClone` tracer before worker-owned PR support lands.",
    "- Do not push branches, open PRs, or write `fp` state from this run; ticket 4 owns that workflow.",
    "- The orchestrator will mark the run needs-attention with `PrArtifactNotImplemented` after your completed turn. That is expected at this migration stage.",
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
    "- Verify the cloned checkout and source metadata, then write the outcome envelope.",
    "- Do not make durable task changes in this migration stage; there is no PR artifact egress yet.",
    "- You may run read-only diagnostics such as `git status`, `git rev-parse HEAD`, and `cat /tmp/.symphony/source.json`.",
  ].join("\n");
};

const outcomeInstructions = (input: WorkerPromptInput): string =>
  input.source.kind === "archive"
    ? "**Before producing your final assistant message / exiting the turn**, you MUST write `/tmp/.symphony/outcome.json` with this exact shape and no extra fields:"
    : "**Before producing your final assistant message / exiting the turn**, you MUST write `/tmp/.symphony/outcome.json` as clone-handoff evidence with this exact shape and no extra fields:";

const summaryInstructions = (input: WorkerPromptInput): string =>
  input.source.kind === "archive"
    ? "The `summary` becomes the fp comment narrative attached to this issue. Include any out-of-scope observations or follow-up suggestions there as prose."
    : "The `summary` is tracer evidence for the orchestrator record. Mention the checked-out SHA and metadata file; do not include secrets.";

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
