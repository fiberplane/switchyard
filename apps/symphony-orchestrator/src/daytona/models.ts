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

const StringRecordSchema = Schema.Record({ key: Schema.String, value: Schema.String });

export const SandboxHandleSchema = Schema.Struct({
  id: NonEmptyString,
  name: NonEmptyString,
  labels: StringRecordSchema,
  envVars: StringRecordSchema,
});
export type SandboxHandle = Schema.Schema.Type<typeof SandboxHandleSchema>;

export const DaytonaSnapshotInfoSchema = Schema.Struct({
  state: NonEmptyString,
  errorReason: Schema.optional(Schema.NullOr(Schema.String)),
});
export type DaytonaSnapshotInfo = Schema.Schema.Type<typeof DaytonaSnapshotInfoSchema>;

export const DaytonaSandboxInfoSchema = Schema.Struct({
  id: NonEmptyString,
  name: NonEmptyString,
  state: Schema.optional(Schema.String),
});
export type DaytonaSandboxInfo = Schema.Schema.Type<typeof DaytonaSandboxInfoSchema>;

export const DaytonaSandboxSpecSchema = Schema.Struct({
  name: NonEmptyString,
  snapshotName: NonEmptyString,
  language: NonEmptyString,
  labels: StringRecordSchema,
  envVars: StringRecordSchema,
  autoStopInterval: Schema.optional(Schema.Number),
  autoDeleteInterval: Schema.optional(Schema.Number),
  createTimeoutSec: Schema.optional(Schema.Number),
});
export type DaytonaSandboxSpec = Schema.Schema.Type<typeof DaytonaSandboxSpecSchema>;

export const DaytonaCommandOptionsSchema = Schema.Struct({
  cwd: Schema.optional(NonEmptyString),
  env: Schema.optional(StringRecordSchema),
  timeoutSec: Schema.optional(Schema.Number),
});
export type DaytonaCommandOptions = Schema.Schema.Type<typeof DaytonaCommandOptionsSchema>;

export const DaytonaCommandResultSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
});
export type DaytonaCommandResult = Schema.Schema.Type<typeof DaytonaCommandResultSchema>;

export const DaytonaExecuteResponseSchema = Schema.Struct({
  result: Schema.String,
});
export type DaytonaExecuteResponse = Schema.Schema.Type<typeof DaytonaExecuteResponseSchema>;

export const DaytonaFileTransferSchema = Schema.Struct({
  src: NonEmptyString,
  dst: NonEmptyString,
});
export type DaytonaFileTransfer = Schema.Schema.Type<typeof DaytonaFileTransferSchema>;

const DaytonaDownloadErrorDetailsSchema = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.optional(Schema.Number),
  errorCode: Schema.optional(Schema.String),
});

const DaytonaDownloadResponseSchema = Schema.Struct({
  source: NonEmptyString,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  errorDetails: Schema.optional(DaytonaDownloadErrorDetailsSchema),
});

export const DaytonaDownloadResponsesSchema = Schema.Array(DaytonaDownloadResponseSchema);
export type DaytonaDownloadResponse = Schema.Schema.Type<typeof DaytonaDownloadResponseSchema>;

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
