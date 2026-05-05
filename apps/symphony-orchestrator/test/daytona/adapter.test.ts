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

describe("DaytonaConfig", () => {
  test("decodes config from a complete env", async () => {
    const config = await Effect.runPromise(
      decodeDaytonaConfigEnv({
        DAYTONA_API_URL: "http://localhost:33000/api",
        DAYTONA_API_KEY: "switchyard-test-api-key",
        DAYTONA_TARGET: "local",
        DAYTONA_SNAPSHOT: "symphony-test-base",
      }),
    );

    expect(config).toEqual({
      apiUrl: "http://localhost:33000/api",
      apiKey: "switchyard-test-api-key",
      target: "local",
      snapshotName: "symphony-test-base",
    });
  });

  test("maps a missing API key env var to DaytonaConfigError", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        decodeDaytonaConfigEnv({
          DAYTONA_API_URL: "http://localhost:33000/api",
          DAYTONA_TARGET: "local",
          DAYTONA_SNAPSHOT: "symphony-test-base",
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

describe("DaytonaAdapter", () => {
  const testRunId = crypto.randomUUID();

  beforeAll(async () => {
    await ensureStackUp();
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
          return yield* adapter.assertSnapshot("symphony-test-base");
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
});
