import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect, Either } from "effect";

import { DaytonaAdapter } from "../../src/daytona/daytona.adapter.js";
import { DaytonaSandboxOpError } from "../../src/daytona/errors.js";
import { SandboxScriptError } from "../../src/sandbox-scripts/errors.js";
import { SANDBOX_REPO_PATH, SANDBOX_SYMPHONY_DIR } from "../../src/sandbox-scripts/models.js";
import { SandboxScriptService } from "../../src/sandbox-scripts/service.js";
import { buildTestSandboxSpec } from "../daytona/test-helpers/sandbox-spec.js";
import { ensureTestSnapshot } from "../daytona/test-helpers/snapshot.js";
import { deleteByTestRunId, ensureStackUp } from "../daytona/test-helpers/stack.js";
import { sweepOrphanedTestSandboxes } from "../daytona/test-helpers/sweep.js";
import { platformLayer, sandboxScriptsLayer } from "./test-helpers/sandbox-setup.js";

const runWithSandboxScripts = <A, E>(
  effect: Effect.Effect<A, E, DaytonaAdapter | SandboxScriptService>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(sandboxScriptsLayer), Effect.provide(platformLayer)),
  );

describe("SandboxScriptService.setupRepo (errors)", () => {
  const testRunId = crypto.randomUUID();

  beforeAll(async () => {
    await ensureStackUp();
    await sweepOrphanedTestSandboxes();
    await ensureTestSnapshot();
  }, 300_000);

  afterAll(async () => {
    await deleteByTestRunId(testRunId);
  }, 180_000);

  test("missing archive path fails as SandboxScriptError carrying the operation tag", async () => {
    const spec = buildTestSandboxSpec({
      testRunId,
      labels: { purpose: "sandbox-scripts-setup-err" },
    });

    const result = await runWithSandboxScripts(
      Effect.gen(function* () {
        const adapter = yield* DaytonaAdapter;
        const service = yield* SandboxScriptService;
        const handle = yield* adapter.createSandbox(spec);
        // No upload of /tmp/repo.tgz — tar will fail to find the archive.
        return yield* Effect.either(
          service.setupRepo(handle, {
            archivePath: "/tmp/repo.tgz",
            repoPath: SANDBOX_REPO_PATH,
            symphonyDir: SANDBOX_SYMPHONY_DIR,
          }),
        );
      }),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SandboxScriptError);
      // Critically, this is *not* a Daytona transport-layer failure — the
      // sandbox + transport are healthy; the script itself failed.
      expect(result.left).not.toBeInstanceOf(DaytonaSandboxOpError);
      if (result.left instanceof SandboxScriptError) {
        expect(result.left.operation).toBe("setupRepo");
        expect(result.left.exitCode).not.toBe(0);
        expect(result.left.stderr.toLowerCase()).toContain("repo.tgz");
      }
    }
  }, 300_000);
});
