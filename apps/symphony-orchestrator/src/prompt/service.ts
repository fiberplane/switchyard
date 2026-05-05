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

    // `satisfies WorkerPromptVars` enforces the closed shape (the variable surface stays
    // pinned at the three keys the prompt contract uses) while the value still flows into
    // `renderTemplate`'s wider `Record<string, string>` parameter.
    const vars = {
      issueDisplayId: input.issue.displayId,
      issueTitle: input.issue.title,
      issueDescription: resolveDescription(input.issue.description),
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
