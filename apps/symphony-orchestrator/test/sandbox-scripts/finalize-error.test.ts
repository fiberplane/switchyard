import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect, Either } from "effect";

import { DaytonaAdapter } from "../../src/daytona/daytona.adapter.js";
import { DaytonaSandboxOpError } from "../../src/daytona/errors.js";
import { SandboxScriptError } from "../../src/sandbox-scripts/errors.js";
import {
  SANDBOX_ARCHIVE_PATH,
  SANDBOX_BUNDLE_PATH,
  SANDBOX_REPO_PATH,
  SANDBOX_SYMPHONY_DIR,
} from "../../src/sandbox-scripts/models.js";
import { SandboxScriptService } from "../../src/sandbox-scripts/service.js";
import { buildTestSandboxSpec } from "../daytona/test-helpers/sandbox-spec.js";
import { ensureTestSnapshot } from "../daytona/test-helpers/snapshot.js";
import { deleteByTestRunId, ensureStackUp } from "../daytona/test-helpers/stack.js";
import { sweepOrphanedTestSandboxes } from "../daytona/test-helpers/sweep.js";
import { platformLayer, sandboxScriptsLayer } from "./test-helpers/sandbox-setup.js";
import { seedArchive } from "./test-helpers/seed-archive.js";

const runWithSandboxScripts = <A, E>(
  effect: Effect.Effect<A, E, DaytonaAdapter | SandboxScriptService>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(sandboxScriptsLayer), Effect.provide(platformLayer)),
  );

describe("SandboxScriptService.finalizeBundle (errors)", () => {
  const testRunId = crypto.randomUUID();

  beforeAll(async () => {
    await ensureStackUp();
    await sweepOrphanedTestSandboxes();
    await ensureTestSnapshot();
  }, 300_000);

  afterAll(async () => {
    await deleteByTestRunId(testRunId);
  }, 180_000);

  test("git bundle create against a working tree without .git fails as SandboxScriptError(finalizeBundle)", async () => {
    const archive = await seedArchive();
    try {
      const spec = buildTestSandboxSpec({
        testRunId,
        labels: { purpose: "sandbox-scripts-finalize-err" },
      });

      const result = await runWithSandboxScripts(
        Effect.gen(function* () {
          const adapter = yield* DaytonaAdapter;
          const service = yield* SandboxScriptService;

          const handle = yield* adapter.createSandbox(spec);
          yield* adapter.uploadFiles(handle, [
            { src: archive.archivePath, dst: SANDBOX_ARCHIVE_PATH },
          ]);
          yield* service.setupRepo(handle, {
            archivePath: SANDBOX_ARCHIVE_PATH,
            repoPath: SANDBOX_REPO_PATH,
            symphonyDir: SANDBOX_SYMPHONY_DIR,
          });

          // Trigger lands inside `git bundle create` (working dir exists,
          // but isn't a git repo) — not in `cd <repoPath>` — so the error
          // mapping is exercised on the bundle command's failure path.
          yield* adapter.executeCommand(handle, `rm -rf ${SANDBOX_REPO_PATH}/.git`);

          return yield* Effect.either(
            service.finalizeBundle(handle, {
              repoPath: SANDBOX_REPO_PATH,
              bundlePath: SANDBOX_BUNDLE_PATH,
            }),
          );
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(SandboxScriptError);
        expect(result.left).not.toBeInstanceOf(DaytonaSandboxOpError);
        if (result.left instanceof SandboxScriptError) {
          expect(result.left.operation).toBe("finalizeBundle");
          expect(result.left.exitCode).not.toBe(0);
          expect(result.left.stderr.toLowerCase()).toContain("git");
        }
      }
    } finally {
      await archive.cleanup();
    }
  }, 300_000);
});
