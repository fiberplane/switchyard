import { describe, expect, test } from "bun:test";

import { Effect, Either } from "effect";

import { DaytonaAdapter, DaytonaAdapterLive } from "../../src/daytona/daytona.adapter.js";
import { DaytonaConfigError } from "../../src/daytona/errors.js";
import { decodeDaytonaConfigEnv } from "../../src/daytona/models.js";

describe("DaytonaConfig", () => {
  test("decodes remote Cloud config from host env", async () => {
    const config = await Effect.runPromise(
      decodeDaytonaConfigEnv({
        DAYTONA_API_KEY: "switchyard-test-api-key",
        DAYTONA_SNAPSHOT: "switchyard-codex-bun-test",
      }),
    );

    expect(config).toEqual({
      apiKey: "switchyard-test-api-key",
      apiUrl: undefined,
      target: undefined,
      snapshotName: "switchyard-codex-bun-test",
    });
  });

  test("honors optional SDK overrides when explicitly configured", async () => {
    const config = await Effect.runPromise(
      decodeDaytonaConfigEnv({
        DAYTONA_API_KEY: "switchyard-test-api-key",
        DAYTONA_API_URL: "https://example.invalid/api",
        DAYTONA_TARGET: "eu",
        DAYTONA_SNAPSHOT: "switchyard-codex-bun-test",
      }),
    );

    expect(config).toEqual({
      apiKey: "switchyard-test-api-key",
      apiUrl: "https://example.invalid/api",
      target: "eu",
      snapshotName: "switchyard-codex-bun-test",
    });
  });

  test("uses workflow snapshot fallback when DAYTONA_SNAPSHOT is omitted", async () => {
    const config = await Effect.runPromise(
      decodeDaytonaConfigEnv(
        {
          DAYTONA_API_KEY: "switchyard-test-api-key",
          DAYTONA_API_URL: "",
          DAYTONA_TARGET: "",
        },
        "switchyard-codex-bun-test",
      ),
    );

    expect(config).toEqual({
      apiKey: "switchyard-test-api-key",
      apiUrl: undefined,
      target: undefined,
      snapshotName: "switchyard-codex-bun-test",
    });
  });

  test("maps a missing API key env var to DaytonaConfigError", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        decodeDaytonaConfigEnv({
          DAYTONA_TARGET: "eu",
          DAYTONA_SNAPSHOT: "switchyard-codex-bun-test",
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

describe("DaytonaAdapterLive", () => {
  test("constructs without probing the remote API", async () => {
    const program = Effect.gen(function* () {
      const adapter = yield* DaytonaAdapter;
      return typeof adapter.createSandbox;
    }).pipe(
      Effect.provide(
        DaytonaAdapterLive({
          apiKey: "switchyard-test-api-key",
          snapshotName: "switchyard-codex-bun-test",
        }),
      ),
    );

    await expect(Effect.runPromise(program)).resolves.toBe("function");
  });
});
