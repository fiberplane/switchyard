import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeContext } from "@effect/platform-node";
import { Effect, Either } from "effect";

import { DaytonaAdapter, DaytonaAdapterLive } from "../../src/daytona/daytona.adapter.js";
import {
  DaytonaConfigError,
  DaytonaSandboxNotFoundError,
  DaytonaSnapshotError,
} from "../../src/daytona/errors.js";
import { decodeDaytonaConfigEnv } from "../../src/daytona/models.js";
import { buildTestSandboxSpec } from "./test-helpers/sandbox-spec.js";
import { ensureInactiveTestSnapshot, ensureTestSnapshot } from "./test-helpers/snapshot.js";
import { daytonaTestConfig, deleteByTestRunId, ensureStackUp } from "./test-helpers/stack.js";
import { sweepOrphanedTestSandboxes } from "./test-helpers/sweep.js";

describe("DaytonaConfig", () => {
  test("decodes config from a complete env", async () => {
    const config = await Effect.runPromise(
      decodeDaytonaConfigEnv({
        DAYTONA_API_URL: "http://localhost:33000/api",
        DAYTONA_API_KEY: "switchyard-test-api-key",
        DAYTONA_TARGET: "local",
        DAYTONA_SNAPSHOT: "symphony-test-codex",
      }),
    );

    expect(config).toEqual({
      apiUrl: "http://localhost:33000/api",
      apiKey: "switchyard-test-api-key",
      target: "local",
      snapshotName: "symphony-test-codex",
    });
  });

  test("maps a missing API key env var to DaytonaConfigError", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        decodeDaytonaConfigEnv({
          DAYTONA_API_URL: "http://localhost:33000/api",
          DAYTONA_TARGET: "local",
          DAYTONA_SNAPSHOT: "symphony-test-codex",
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(DaytonaConfigError);
      if (result.left instanceof DaytonaConfigError) {
        expect(result.left.missingFields).toContain("DAYTONA_API_KEY");
        expect(result.left.details).toContain('["DAYTONA_API_KEY"]');
      }
    }
  });
});

describe("Daytona test sandbox spec", () => {
  test("preserves cleanup labels when caller labels collide", () => {
    const testRunId = crypto.randomUUID();
    const spec = buildTestSandboxSpec({
      testRunId,
      labels: {
        app: "wrong-app",
        test_run_id: "wrong-run",
        created_at_ms: "0",
        purpose: "label-protection",
      },
    });

    expect(spec.labels.app).toBe("symphony-test");
    expect(spec.labels.test_run_id).toBe(testRunId);
    expect(spec.labels.created_at_ms).not.toBe("0");
    expect(spec.labels.purpose).toBe("label-protection");
  });
});

describe("DaytonaAdapter", () => {
  const testRunId = crypto.randomUUID();

  beforeAll(async () => {
    await ensureStackUp();
    await sweepOrphanedTestSandboxes();
    await ensureTestSnapshot();
  }, 300_000);

  afterAll(async () => {
    await deleteByTestRunId(testRunId);
  }, 180_000);

  const runWithAdapter = <A, E>(effect: Effect.Effect<A, E, DaytonaAdapter>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(DaytonaAdapterLive(daytonaTestConfig)),
        Effect.provide(NodeContext.layer),
      ),
    );

  const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

  test("constructs a client against the test stack", async () => {
    await ensureStackUp();

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          yield* DaytonaAdapter;
        }).pipe(
          Effect.provide(
            DaytonaAdapterLive(daytonaTestConfig, {
              probeOnInit: true,
            }),
          ),
          Effect.provide(NodeContext.layer),
        ),
      ),
    ).resolves.toBeUndefined();
  }, 180_000);

  test("assertSnapshot succeeds for the active test snapshot", async () => {
    await ensureStackUp();
    await ensureTestSnapshot();

    await expect(
      runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* DaytonaAdapter;
          return yield* adapter.assertSnapshot("symphony-test-codex");
        }),
      ),
    ).resolves.toBeUndefined();
  }, 300_000);

  test("assertSnapshot maps a missing snapshot to DaytonaSnapshotError", async () => {
    await ensureStackUp();

    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* DaytonaAdapter;
        return yield* Effect.either(adapter.assertSnapshot("does-not-exist"));
      }),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(DaytonaSnapshotError);
      if (result.left instanceof DaytonaSnapshotError) {
        expect(result.left.snapshotName).toBe("does-not-exist");
      }
    }
  }, 180_000);

  test("assertSnapshot maps an inactive snapshot to DaytonaSnapshotError", async () => {
    await ensureStackUp();
    const inactiveSnapshotName = await ensureInactiveTestSnapshot();

    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* DaytonaAdapter;
        return yield* Effect.either(adapter.assertSnapshot(inactiveSnapshotName));
      }),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(DaytonaSnapshotError);
      if (result.left instanceof DaytonaSnapshotError) {
        expect(result.left.snapshotName).toBe(inactiveSnapshotName);
        expect(result.left.state).toBe("inactive");
      }
    }
  }, 300_000);

  test("createSandbox returns an opaque handle with caller-supplied labels", async () => {
    const spec = buildTestSandboxSpec({
      testRunId,
      labels: {
        purpose: "create",
      },
      envVars: {
        SWITCHYARD_TEST: "create",
      },
    });

    const handle = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* DaytonaAdapter;
        return yield* adapter.createSandbox(spec);
      }),
    );

    expect(handle.id.length).toBeGreaterThan(0);
    expect(handle.name).toBe(spec.name);
    expect(handle.labels).toEqual(spec.labels);
    expect(handle.envVars).toEqual(spec.envVars);
  }, 300_000);

  test("deleteSandbox is idempotent and command execution maps the deleted handle to not found", async () => {
    const spec = buildTestSandboxSpec({
      testRunId,
      labels: {
        purpose: "delete",
      },
    });

    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* DaytonaAdapter;
        const handle = yield* adapter.createSandbox(spec);
        yield* adapter.deleteSandbox(handle);
        yield* adapter.deleteSandbox(handle);
        return yield* Effect.either(adapter.executeCommand(handle, "echo deleted"));
      }),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(DaytonaSandboxNotFoundError);
      if (result.left instanceof DaytonaSandboxNotFoundError) {
        expect(result.left.sandboxId.length).toBeGreaterThan(0);
        expect(result.left.operation).toBe("executeCommand");
      }
    }
  }, 300_000);

  test("uploadFiles places a non-empty archive in the sandbox", async () => {
    const uploadRoot = await mkdtemp(join(tmpdir(), "switchyard-daytona-upload-"));
    const archivePath = join(uploadRoot, "repo.tgz");
    await writeFile(archivePath, "switchyard upload fixture\n");

    try {
      const spec = buildTestSandboxSpec({
        testRunId,
        labels: {
          purpose: "upload",
        },
      });

      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* DaytonaAdapter;
          const handle = yield* adapter.createSandbox(spec);
          yield* adapter.uploadFiles(handle, [{ src: archivePath, dst: "/tmp/repo.tgz" }]);
          return yield* adapter.executeCommand(
            handle,
            "test -s /tmp/repo.tgz && ls -l /tmp/repo.tgz",
          );
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("/tmp/repo.tgz");
    } finally {
      await rm(uploadRoot, { recursive: true, force: true });
    }
  }, 300_000);

  test("uploadFiles transfers multiple files without truncating later entries", async () => {
    const uploadRoot = await mkdtemp(join(tmpdir(), "switchyard-daytona-upload-many-"));
    const firstPath = join(uploadRoot, "first.txt");
    const secondPath = join(uploadRoot, "second.txt");
    const thirdPath = join(uploadRoot, "third.txt");
    await writeFile(firstPath, "first\n");
    await writeFile(secondPath, "second\n");
    await writeFile(thirdPath, "third\n");

    try {
      const spec = buildTestSandboxSpec({
        testRunId,
        labels: {
          purpose: "upload-many",
        },
      });

      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* DaytonaAdapter;
          const handle = yield* adapter.createSandbox(spec);
          yield* adapter.uploadFiles(handle, [
            { src: firstPath, dst: "/tmp/first.txt" },
            { src: secondPath, dst: "/tmp/second.txt" },
            { src: thirdPath, dst: "/tmp/third.txt" },
          ]);
          return yield* adapter.executeCommand(
            handle,
            "wc -c /tmp/first.txt /tmp/second.txt /tmp/third.txt && cat /tmp/first.txt /tmp/second.txt /tmp/third.txt",
          );
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("first\nsecond\nthird\n");
    } finally {
      await rm(uploadRoot, { recursive: true, force: true });
    }
  }, 300_000);

  test("downloadFiles round-trips uploaded bytes", async () => {
    const transferRoot = await mkdtemp(join(tmpdir(), "switchyard-daytona-download-"));
    const sourcePath = join(transferRoot, "repo.tgz");
    const copyPath = join(transferRoot, "repo-copy.tgz");
    await writeFile(sourcePath, "switchyard download fixture\n");

    try {
      const spec = buildTestSandboxSpec({
        testRunId,
        labels: {
          purpose: "download",
        },
      });

      await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* DaytonaAdapter;
          const handle = yield* adapter.createSandbox(spec);
          yield* adapter.uploadFiles(handle, [{ src: sourcePath, dst: "/tmp/repo.tgz" }]);
          yield* adapter.downloadFiles(handle, [{ src: "/tmp/repo.tgz", dst: copyPath }]);
        }),
      );

      expect(sha256(await readFile(copyPath))).toBe(sha256(await readFile(sourcePath)));
    } finally {
      await rm(transferRoot, { recursive: true, force: true });
    }
  }, 300_000);

  test("executeCommand returns stdout and stderr separately", async () => {
    const spec = buildTestSandboxSpec({
      testRunId,
      labels: {
        purpose: "execute",
      },
    });

    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* DaytonaAdapter;
        const handle = yield* adapter.createSandbox(spec);
        return yield* adapter.executeCommand(handle, "echo hello");
      }),
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
    });
  }, 300_000);

  test("executeCommand returns non-zero exit as data", async () => {
    const spec = buildTestSandboxSpec({
      testRunId,
      labels: {
        purpose: "execute-nonzero",
      },
    });

    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* DaytonaAdapter;
        const handle = yield* adapter.createSandbox(spec);
        return yield* adapter.executeCommand(handle, "echo nope >&2; exit 17");
      }),
    );

    expect(result).toEqual({
      exitCode: 17,
      stdout: "",
      stderr: "nope\n",
    });
  }, 300_000);

  test("executeCommand maps a missing sandbox handle to DaytonaSandboxNotFoundError", async () => {
    const missingHandle = {
      id: crypto.randomUUID(),
      name: "missing-sandbox",
      labels: {},
      envVars: {},
    };

    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* DaytonaAdapter;
        return yield* Effect.either(adapter.executeCommand(missingHandle, "echo never"));
      }),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(DaytonaSandboxNotFoundError);
      if (result.left instanceof DaytonaSandboxNotFoundError) {
        expect(result.left.sandboxId).toBe(missingHandle.id);
        expect(result.left.operation).toBe("executeCommand");
      }
    }
  }, 180_000);
});
