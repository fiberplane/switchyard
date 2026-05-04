import { describe, expect, test } from "bun:test";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Either, Option, Schema } from "effect";

import { ArtifactDecodeError } from "../../src/artifact/errors.js";
import {
  decodeWorkerOutcome,
  type OrchestratorRecord,
  WorkerOutcomeSchema,
} from "../../src/artifact/models.js";
import { ArtifactStore, ArtifactStoreLive } from "../../src/artifact/store.js";

const fixturePath = (name: string) => `test/fixtures/artifact/${name}`;

const readFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await Bun.file(fixturePath(name)).text());

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

describe("WorkerOutcomeSchema", () => {
  test("decodes the completed outcome fixture", async () => {
    const outcome = await Effect.runPromise(
      Schema.decodeUnknown(WorkerOutcomeSchema)(await readFixture("outcome.completed.json")),
    );

    expect(outcome.status).toBe("completed");
  });

  test("maps malformed status to ArtifactDecodeError", async () => {
    const path = fixturePath("outcome.malformed-status.json");
    const result = await Effect.runPromise(
      Effect.either(decodeWorkerOutcome(await readFixture("outcome.malformed-status.json"), path)),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const error = result.left;
      expect(error).toBeInstanceOf(ArtifactDecodeError);
      if (error instanceof ArtifactDecodeError) {
        expect(error.path).toBe(path);
        expect(error.details).toContain('["status"]');
      }
    }
  });
});

describe("ArtifactStore", () => {
  test("computes the run directory for an issue attempt", async () => {
    const runDir = await runWithArtifactStore(
      artifactBase,
      Effect.gen(function* () {
        const store = yield* ArtifactStore;
        return store.runDir("SWYRD-abc", 1);
      }),
    );

    expect(runDir).toBe(`${artifactBase}/runs/SWYRD-abc/1`);
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

          yield* fs.makeDirectory(store.runDir("SWYRD-abc", 10), { recursive: true });
          yield* fs.makeDirectory(store.runDir("SWYRD-abc", 2), { recursive: true });
          yield* fs.makeDirectory(store.runDir("SWYRD-abc", 1), { recursive: true });

          return yield* store.listRuns("SWYRD-abc");
        }),
      ),
    );

    expect(attempts).toEqual([1, 2, 10]);
  });
});
