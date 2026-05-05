import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const runHostGit = async (
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("SandboxScriptService round-trip", () => {
  const testRunId = crypto.randomUUID();

  beforeAll(async () => {
    await ensureStackUp();
    await sweepOrphanedTestSandboxes();
    await ensureTestSnapshot();
  }, 300_000);

  afterAll(async () => {
    await deleteByTestRunId(testRunId);
  }, 180_000);

  test("archive → upload → setup → commit → finalize → download → host git bundle verify", async () => {
    const archive = await seedArchive();
    const downloadRoot = await mkdtemp(join(tmpdir(), "switchyard-sbox-download-"));
    try {
      const localBundlePath = join(downloadRoot, "work.bundle");
      const spec = buildTestSandboxSpec({
        testRunId,
        labels: { purpose: "sandbox-scripts-roundtrip" },
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
          yield* adapter.executeCommand(
            handle,
            [
              "set -euo pipefail",
              `cd ${SANDBOX_REPO_PATH}`,
              "echo round-trip > artifact.txt",
              "git add artifact.txt",
              "git -c user.name=Worker -c user.email=worker@example.com commit -q -m round-trip",
            ].join("\n"),
          );
          const finalize = yield* service.finalizeBundle(handle, {
            repoPath: SANDBOX_REPO_PATH,
            bundlePath: SANDBOX_BUNDLE_PATH,
          });
          yield* adapter.downloadFiles(handle, [
            { src: SANDBOX_BUNDLE_PATH, dst: localBundlePath },
          ]);
          return finalize;
        }),
      );

      expect(result.bundlePath).toBe(SANDBOX_BUNDLE_PATH);
      expect(result.commitsBeyondBase).toBe(1);

      // Host-side verification: the downloaded bundle is self-contained and
      // exposes a single ref (HEAD), so `git bundle list-heads` must return
      // exactly one entry. Confirms the contract that the integration leaf
      // (sibling) consumes via `git fetch --no-tags <bundle> +HEAD:refs/...`.
      const verify = await runHostGit(["bundle", "verify", localBundlePath]);
      expect(verify.exitCode).toBe(0);

      const heads = await runHostGit(["bundle", "list-heads", localBundlePath]);
      expect(heads.exitCode).toBe(0);
      const headLines = heads.stdout
        .trim()
        .split("\n")
        .filter((line) => line !== "");
      expect(headLines).toHaveLength(1);
      expect(headLines[0]).toMatch(/HEAD$/);
    } finally {
      await archive.cleanup();
      await rm(downloadRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
