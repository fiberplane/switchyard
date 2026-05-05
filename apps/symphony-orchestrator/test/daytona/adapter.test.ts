import { describe, expect, test } from "bun:test";

import { Effect, Either } from "effect";

import { DaytonaConfigError } from "../../src/daytona/errors.js";
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
