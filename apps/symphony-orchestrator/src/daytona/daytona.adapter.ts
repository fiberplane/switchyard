import { Daytona } from "@daytona/sdk";
import { Context, Effect, Layer } from "effect";

import { DaytonaSandboxOpError } from "./errors.js";
import type { DaytonaConfig } from "./models.js";

export type DaytonaAdapterShape = Record<string, never>;

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

      return {};
    }),
  );
