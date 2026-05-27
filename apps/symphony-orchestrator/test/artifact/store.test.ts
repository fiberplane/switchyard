import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Either, Option } from "effect";

import { ArtifactDecodeError, ArtifactPathError } from "../../src/artifact/errors.js";
import { type OrchestratorRecord } from "../../src/artifact/models.js";
import { ArtifactStore, ArtifactStoreLive } from "../../src/artifact/store.js";

const artifactBase = "/tmp/switchyard-artifacts";

const runWithFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));

const runWithArtifactStore = <A, E>(
  basePath: string,
  effect: Effect.Effect<A, E, ArtifactStore | FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(ArtifactStoreLive(basePath)), Effect.provide(NodeFileSystem.layer)),
  );

const withTempArtifactStore = async <A>(run: (basePath: string) => Promise<A>): Promise<A> => {
  const basePath = await runWithFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory({ prefix: "symphony-artifacts-" });
    }),
  );

  try {
    return await run(basePath);
  } finally {
    await runWithFileSystem(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(basePath, { recursive: true });
      }),
    );
  }
};

describe("ArtifactStore", () => {
  test("computes the run directory for an issue attempt", async () => {
    const runDir = await runWithArtifactStore(
      artifactBase,
      Effect.gen(function* () {
        const store = yield* ArtifactStore;
        return yield* store.runDir("SWYRD-abc", 1);
      }),
    );

    expect(runDir).toBe(`${artifactBase}/runs/SWYRD-abc/1`);
  });

  test("rejects invalid run path inputs", async () => {
    const invalidIssue = await runWithArtifactStore(
      artifactBase,
      Effect.gen(function* () {
        const store = yield* ArtifactStore;
        return yield* Effect.either(store.runDir("../escape", 1));
      }),
    );
    const invalidAttempt = await runWithArtifactStore(
      artifactBase,
      Effect.gen(function* () {
        const store = yield* ArtifactStore;
        return yield* Effect.either(store.runDir("SWYRD-abc", 1.5));
      }),
    );

    expect(Either.isLeft(invalidIssue)).toBe(true);
    if (Either.isLeft(invalidIssue)) {
      expect(invalidIssue.left).toBeInstanceOf(ArtifactPathError);
      expect(invalidIssue.left.operation).toBe("validate issue id");
    }
    expect(Either.isLeft(invalidAttempt)).toBe(true);
    if (Either.isLeft(invalidAttempt)) {
      expect(invalidAttempt.left).toBeInstanceOf(ArtifactPathError);
      expect(invalidAttempt.left.operation).toBe("validate attempt");
    }
  });

  test("round-trips an orchestrator record", async () => {
    const record: OrchestratorRecord = {
      status: "integrated",
      branch: "symphony/SWYRD-abc",
      baseRev: "abc123",
      workerStatus: Option.some("completed"),
      startedAt: "2026-05-04T20:00:00.000Z",
      endedAt: "2026-05-04T20:01:00.000Z",
      attempt: 1,
    };

    const readBack = await withTempArtifactStore((basePath) =>
      runWithArtifactStore(
        basePath,
        Effect.gen(function* () {
          const store = yield* ArtifactStore;
          yield* store.writeRecord("SWYRD-abc", 1, record);
          return yield* store.readRecord("SWYRD-abc", 1);
        }),
      ),
    );

    expect(readBack).toEqual(record);
  });

  test("lists run attempts in numeric order", async () => {
    const attempts = await withTempArtifactStore((basePath) =>
      runWithArtifactStore(
        basePath,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const store = yield* ArtifactStore;

          yield* fs.makeDirectory(yield* store.runDir("SWYRD-abc", 10), { recursive: true });
          yield* fs.makeDirectory(yield* store.runDir("SWYRD-abc", 2), { recursive: true });
          yield* fs.makeDirectory(yield* store.runDir("SWYRD-abc", 1), { recursive: true });

          return yield* store.listRuns("SWYRD-abc");
        }),
      ),
    );

    expect(attempts).toEqual([1, 2, 10]);
  });

  test("returns no runs for a missing issue directory", async () => {
    const attempts = await withTempArtifactStore((basePath) =>
      runWithArtifactStore(
        basePath,
        Effect.gen(function* () {
          const store = yield* ArtifactStore;
          return yield* store.listRuns("SWYRD-abc");
        }),
      ),
    );

    expect(attempts).toEqual([]);
  });

  test("maps missing orchestrator records to ArtifactPathError", async () => {
    const result = await withTempArtifactStore((basePath) =>
      runWithArtifactStore(
        basePath,
        Effect.gen(function* () {
          const store = yield* ArtifactStore;
          return yield* Effect.either(store.readRecord("SWYRD-abc", 1));
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ArtifactPathError);
      expect(result.left.path).toContain("outcome-record.json");
      if (result.left instanceof ArtifactPathError) {
        expect(result.left.operation).toBe("read file");
      }
    }
  });

  test("maps malformed orchestrator records to ArtifactDecodeError", async () => {
    const result = await withTempArtifactStore((basePath) =>
      runWithArtifactStore(
        basePath,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const store = yield* ArtifactStore;
          const dir = yield* store.runDir("SWYRD-abc", 1);

          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.writeFileString(join(dir, "outcome-record.json"), '{"status":"ok"}\n');

          return yield* Effect.either(store.readRecord("SWYRD-abc", 1));
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ArtifactDecodeError);
      expect(result.left.path).toContain("outcome-record.json");
      if (result.left instanceof ArtifactDecodeError) {
        expect(result.left.details).toContain('["status"]');
      }
    }
  });
});
