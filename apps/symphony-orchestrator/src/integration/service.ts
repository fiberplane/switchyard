import { join } from "node:path";

import { Error as PlatformError, FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";

import { integrateBundle as integrateBundleImpl } from "./bundle.js";
import { GitCommandError, type BundleFetchError } from "./errors.js";
import { GitAdapter } from "./git.adapter.js";
import type { IntegrationResult, SourceHandoff } from "./models.js";

export type IntegrationServiceShape = {
  readonly prepareSourceHandoff: () => Effect.Effect<SourceHandoff, GitCommandError>;
  readonly integrateBundle: (
    bundlePath: string,
    issueId: string,
    options?: { readonly suffix?: string },
  ) => Effect.Effect<IntegrationResult, GitCommandError | BundleFetchError>;
};

export class IntegrationService extends Context.Tag("IntegrationService")<
  IntegrationService,
  IntegrationServiceShape
>() {}

const ARCHIVE_PREFIX = "swy-source-";
const ARCHIVE_FILENAME = "source.tar.gz";

export const IntegrationServiceLive = Layer.effect(
  IntegrationService,
  Effect.gen(function* () {
    const git = yield* GitAdapter;
    const fs = yield* FileSystem.FileSystem;

    return {
      prepareSourceHandoff: () =>
        Effect.gen(function* () {
          const baseRev = yield* git.revParse("HEAD");
          // Caller owns archive cleanup. tmpdir failures (no /tmp, full disk, perms) are
          // routed through GitCommandError so the orchestrator can log + needs-attention
          // them like any other handoff failure rather than crashing the fiber.
          const dir = yield* fs.makeTempDirectory({ prefix: ARCHIVE_PREFIX }).pipe(
            Effect.mapError(
              (error: PlatformError.PlatformError) =>
                new GitCommandError({
                  command: ["mktemp", "-d", `${ARCHIVE_PREFIX}XXXXXX`],
                  stderr: error.message,
                  exitCode: -1,
                }),
            ),
          );
          const archivePath = join(dir, ARCHIVE_FILENAME);
          yield* git.archive(baseRev, archivePath);
          return { baseRev, archivePath };
        }),
      integrateBundle: (bundlePath, issueId, options) =>
        integrateBundleImpl(git, bundlePath, issueId, options),
    };
  }),
);
