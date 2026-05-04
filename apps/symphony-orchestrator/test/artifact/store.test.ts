import { describe, expect, test } from "bun:test";

import { Effect, Either, Schema } from "effect";

import { ArtifactDecodeError } from "../../src/artifact/errors.js";
import {
  decodeWorkerOutcome,
  WorkerOutcomeSchema,
} from "../../src/artifact/models.js";

const fixturePath = (name: string) => `test/fixtures/artifact/${name}`;

const readFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await Bun.file(fixturePath(name)).text());

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
