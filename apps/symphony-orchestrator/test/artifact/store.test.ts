import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { WorkerOutcomeSchema } from "../../src/artifact/models.js";

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
});
