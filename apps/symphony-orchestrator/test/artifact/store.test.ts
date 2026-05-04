import { describe, expect, test } from "bun:test";

import { Effect, Either, Schema } from "effect";

import { ArtifactDecodeError } from "../../src/artifact/errors.js";
import {
  decodeWorkerOutcome,
  WorkerOutcomeSchema,
} from "../../src/artifact/models.js";
import { ArtifactStore, ArtifactStoreLive } from "../../src/artifact/store.js";

const fixturePath = (name: string) => `test/fixtures/artifact/${name}`;

const readFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await Bun.file(fixturePath(name)).text());

const artifactBase = "/tmp/switchyard-artifacts";

const runWithArtifactStore = <A, E>(effect: Effect.Effect<A, E, ArtifactStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ArtifactStoreLive(artifactBase))));

describe("WorkerOutcomeSchema", () => {
  test("decodes the completed outcome fixture", async () => {
    const outcome = await Effect.runPromise(
      Schema.decodeUnknown(WorkerOutcomeSchema)(
        await readFixture("outcome.completed.json"),
      ),
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
      Effect.gen(function* () {
        const store = yield* ArtifactStore;
        return store.runDir("SWYRD-abc", 1);
      }),
    );

    expect(runDir).toBe(`${artifactBase}/runs/SWYRD-abc/1`);
  });
});
