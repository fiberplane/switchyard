import { Effect, ParseResult, Schema } from "effect";

import { DaytonaConfigError } from "./errors.js";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const DaytonaConfigEnvFields = [
  "DAYTONA_API_URL",
  "DAYTONA_API_KEY",
  "DAYTONA_TARGET",
  "DAYTONA_SNAPSHOT",
] as const;

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

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const missingConfigEnvFields = (env: unknown): readonly string[] => {
  if (!isUnknownRecord(env)) {
    return DaytonaConfigEnvFields;
  }

  return DaytonaConfigEnvFields.filter((field) => {
    const value = env[field];
    return typeof value !== "string" || value.length === 0;
  });
};

export const decodeDaytonaConfigEnv = (
  env: unknown,
): Effect.Effect<DaytonaConfig, DaytonaConfigError> =>
  Schema.decodeUnknown(DaytonaConfigEnvSchema)(env).pipe(
    Effect.flatMap((decodedEnv) =>
      Schema.decodeUnknown(DaytonaConfigSchema)({
        apiUrl: decodedEnv.DAYTONA_API_URL,
        apiKey: decodedEnv.DAYTONA_API_KEY,
        target: decodedEnv.DAYTONA_TARGET,
        snapshotName: decodedEnv.DAYTONA_SNAPSHOT,
      }),
    ),
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new DaytonaConfigError({
          missingFields: missingConfigEnvFields(env),
          details: ParseResult.TreeFormatter.formatErrorSync(error),
        }),
      ),
    ),
  );
