import { Daytona } from "@daytona/sdk";
import { Context, Effect, Layer } from "effect";

import { DaytonaSandboxOpError, DaytonaSnapshotError } from "./errors.js";
import type { DaytonaConfig } from "./models.js";

export type DaytonaAdapterShape = {
  readonly assertSnapshot: (name: string) => Effect.Effect<void, DaytonaSnapshotError>;
};

export class DaytonaAdapter extends Context.Tag("DaytonaAdapter")<
  DaytonaAdapter,
  DaytonaAdapterShape
>() {}

export type DaytonaAdapterOptions = {
  readonly probeOnInit?: boolean;
};

const describeUnknown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const createDaytonaClient = (config: DaytonaConfig): Daytona =>
  new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    target: config.target,
    _experimental: {
      otelEnabled: false,
    },
  });

const probeDaytonaClient = (client: Daytona): Effect.Effect<void, DaytonaSandboxOpError> =>
  Effect.tryPromise({
    try: async () => {
      await client.snapshot.list(1, 1);
    },
    catch: (error) =>
      new DaytonaSandboxOpError({
        operation: "snapshot.list",
        reason: describeUnknown(error),
      }),
  }).pipe(Effect.asVoid);

const assertSnapshot = (
  client: Daytona,
  name: string,
): Effect.Effect<void, DaytonaSnapshotError> =>
  Effect.tryPromise({
    try: () => client.snapshot.get(name),
    catch: (error) =>
      new DaytonaSnapshotError({
        snapshotName: name,
        reason: describeUnknown(error),
      }),
  }).pipe(
    Effect.flatMap((snapshot) => {
      if (snapshot.state === "active") {
        return Effect.void;
      }

      return Effect.fail(
        new DaytonaSnapshotError({
          snapshotName: name,
          state: String(snapshot.state),
          reason: "expected active snapshot",
        }),
      );
    }),
    Effect.withSpan("DaytonaAdapter.assertSnapshot"),
  );

export const DaytonaAdapterLive = (
  config: DaytonaConfig,
  options: DaytonaAdapterOptions = {},
) =>
  Layer.effect(
    DaytonaAdapter,
    Effect.gen(function* () {
      const client = createDaytonaClient(config);

      if (options.probeOnInit === true) {
        yield* probeDaytonaClient(client);
      }

      return {
        assertSnapshot: (name) => assertSnapshot(client, name),
      };
    }),
  );
