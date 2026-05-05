import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { NodeContext } from "@effect/platform-node";
import { Effect, Either } from "effect";

import { DaytonaAdapter, DaytonaAdapterLive } from "../../src/daytona/daytona.adapter.js";
import { DaytonaConfigError, DaytonaSnapshotError } from "../../src/daytona/errors.js";
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
});
