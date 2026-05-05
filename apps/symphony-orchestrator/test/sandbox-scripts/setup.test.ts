import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { DaytonaAdapter } from "../../src/daytona/daytona.adapter.js";
import {
  SANDBOX_ARCHIVE_PATH,
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

describe("SandboxScriptService.setupRepo", () => {
  const testRunId = crypto.randomUUID();

  beforeAll(async () => {
    await ensureStackUp();
    await sweepOrphanedTestSandboxes();
    await ensureTestSnapshot();
  }, 300_000);

  afterAll(async () => {
    await deleteByTestRunId(testRunId);
  }, 180_000);

  test("extracts archive, inits git, tags symphony-base, ensures /tmp/.symphony exists", async () => {
    const archive = await seedArchive();
    try {
      const spec = buildTestSandboxSpec({
        testRunId,
        labels: { purpose: "sandbox-scripts-setup" },
      });

      const probes = await runWithSandboxScripts(
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

          const baseRev = yield* adapter.executeCommand(
            handle,
            `cd ${SANDBOX_REPO_PATH} && git rev-parse symphony-base`,
          );
          const symphonyDir = yield* adapter.executeCommand(
            handle,
            `test -d ${SANDBOX_SYMPHONY_DIR}`,
          );
          return { baseRev, symphonyDir };
        }),
      );

      expect(probes.baseRev.exitCode).toBe(0);
      expect(probes.baseRev.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
      expect(probes.symphonyDir.exitCode).toBe(0);
    } finally {
      await archive.cleanup();
    }
  }, 300_000);
});
