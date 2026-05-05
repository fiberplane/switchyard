import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { DaytonaAdapter } from "../../src/daytona/daytona.adapter.js";
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

describe("SandboxScriptService.finalizeBundle", () => {
  const testRunId = crypto.randomUUID();

  beforeAll(async () => {
    await ensureStackUp();
    await sweepOrphanedTestSandboxes();
    await ensureTestSnapshot();
  }, 300_000);

  afterAll(async () => {
    await deleteByTestRunId(testRunId);
  }, 180_000);

  test("after two worker commits, returns commitsBeyondBase=2 and a verifiable bundle", async () => {
    const archive = await seedArchive();
    try {
      const spec = buildTestSandboxSpec({
        testRunId,
        labels: { purpose: "sandbox-scripts-finalize-2" },
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

          // Simulate two worker commits inside the sandbox.
          yield* adapter.executeCommand(
            handle,
            [
              "set -euo pipefail",
              `cd ${SANDBOX_REPO_PATH}`,
              "echo a > x.txt",
              "git add x.txt",
              "git -c user.name=Worker -c user.email=worker@example.com commit -q -m a",
              "echo b >> x.txt",
              "git add x.txt",
              "git -c user.name=Worker -c user.email=worker@example.com commit -q -m b",
            ].join("\n"),
          );

          const result = yield* service.finalizeBundle(handle, {
            repoPath: SANDBOX_REPO_PATH,
            bundlePath: SANDBOX_BUNDLE_PATH,
          });
          const verify = yield* adapter.executeCommand(
            handle,
            `cd ${SANDBOX_REPO_PATH} && git bundle verify ${SANDBOX_BUNDLE_PATH}`,
          );
          return { result, verify };
        }),
      );

      expect(probes.result.bundlePath).toBe(SANDBOX_BUNDLE_PATH);
      expect(probes.result.commitsBeyondBase).toBe(2);
      expect(probes.verify.exitCode).toBe(0);
    } finally {
      await archive.cleanup();
    }
  }, 300_000);

  // Empty-commit case is load-bearing per ADR D6: the sandbox always has a
  // single-commit history rooted at symphony-base, so `git bundle create … HEAD`
  // produces a valid 1-commit bundle even when the worker contributed nothing.
  // No impl change vs. cycle 4 — the test pins the invariant for bisect-ability.
  test("with no worker commits, returns commitsBeyondBase=0 and the bundle still verifies", async () => {
    const archive = await seedArchive();
    try {
      const spec = buildTestSandboxSpec({
        testRunId,
        labels: { purpose: "sandbox-scripts-finalize-0" },
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

          // No worker commits — go straight to finalize.
          const result = yield* service.finalizeBundle(handle, {
            repoPath: SANDBOX_REPO_PATH,
            bundlePath: SANDBOX_BUNDLE_PATH,
          });
          const verify = yield* adapter.executeCommand(
            handle,
            `cd ${SANDBOX_REPO_PATH} && git bundle verify ${SANDBOX_BUNDLE_PATH}`,
          );
          const heads = yield* adapter.executeCommand(
            handle,
            `cd ${SANDBOX_REPO_PATH} && git bundle list-heads ${SANDBOX_BUNDLE_PATH}`,
          );
          const baseRev = yield* adapter.executeCommand(
            handle,
            `cd ${SANDBOX_REPO_PATH} && git rev-parse symphony-base`,
          );
          return { result, verify, heads, baseRev };
        }),
      );

      expect(probes.result.bundlePath).toBe(SANDBOX_BUNDLE_PATH);
      expect(probes.result.commitsBeyondBase).toBe(0);
      expect(probes.verify.exitCode).toBe(0);
      // The bundle's single ref must be HEAD pointing at the symphony-base
      // commit — guards against a regression that produced a 0-commit count
      // but a wrong tip (e.g., bundling something other than HEAD).
      expect(probes.heads.exitCode).toBe(0);
      const headLines = probes.heads.stdout
        .trim()
        .split("\n")
        .filter((line) => line !== "");
      expect(headLines).toHaveLength(1);
      const baseSha = probes.baseRev.stdout.trim();
      expect(headLines[0]).toBe(`${baseSha} HEAD`);
    } finally {
      await archive.cleanup();
    }
  }, 300_000);
});
