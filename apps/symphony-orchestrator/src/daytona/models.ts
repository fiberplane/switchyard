import { Effect, Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

const DaytonaConfigEnvSchema = Schema.Struct({
  DAYTONA_API_URL: NonEmptyString,
  DAYTONA_API_KEY: NonEmptyString,
  DAYTONA_TARGET: NonEmptyString,
  DAYTONA_SNAPSHOT: NonEmptyString,
});

export const DaytonaConfigSchema = Schema.Struct({
  apiUrl: NonEmptyString,
  apiKey: NonEmptyString,
  target: NonEmptyString,
  snapshotName: NonEmptyString,
});
export type DaytonaConfig = Schema.Schema.Type<typeof DaytonaConfigSchema>;

export const decodeDaytonaConfigEnv = (env: unknown) =>
  Schema.decodeUnknown(DaytonaConfigEnvSchema)(env).pipe(
    Effect.flatMap((decodedEnv) =>
      Schema.decodeUnknown(DaytonaConfigSchema)({
        apiUrl: decodedEnv.DAYTONA_API_URL,
        apiKey: decodedEnv.DAYTONA_API_KEY,
        target: decodedEnv.DAYTONA_TARGET,
        snapshotName: decodedEnv.DAYTONA_SNAPSHOT,
      }),
    ),
  );
