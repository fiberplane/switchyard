import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { decodeDaytonaConfigEnv } from "../../src/daytona/models.js";

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
});
