import { Effect, ParseResult, Schema } from "effect";

import { DaytonaConfigError } from "./errors.js";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const DaytonaConfigEnvFields = ["DAYTONA_API_KEY", "DAYTONA_SNAPSHOT"] as const;

const DaytonaConfigEnvSchema = Schema.Struct({
  DAYTONA_API_KEY: NonEmptyString,
  DAYTONA_API_URL: Schema.optional(NonEmptyString),
  DAYTONA_TARGET: Schema.optional(NonEmptyString),
  DAYTONA_SNAPSHOT: Schema.optional(NonEmptyString),
});

export const DaytonaConfigSchema = Schema.Struct({
  apiUrl: Schema.optional(NonEmptyString),
  apiKey: NonEmptyString,
  target: Schema.optional(NonEmptyString),
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

const missingConfigEnvFields = (
  env: unknown,
  fallbackSnapshotName: string | undefined,
): readonly string[] => {
  if (!isUnknownRecord(env)) {
    return DaytonaConfigEnvFields;
  }

  const missing = DaytonaConfigEnvFields.filter((field) => {
    const value = env[field];
    return typeof value !== "string" || value.length === 0;
  });

  return fallbackSnapshotName === undefined
    ? missing
    : missing.filter((field) => field !== "DAYTONA_SNAPSHOT");
};

const normalizeEnv = (env: unknown): unknown => {
  if (!isUnknownRecord(env)) {
    return env;
  }

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === "" ? undefined : value]),
  );
};

export const decodeDaytonaConfigEnv = (
  env: unknown,
  fallbackSnapshotName?: string,
): Effect.Effect<DaytonaConfig, DaytonaConfigError> =>
  Schema.decodeUnknown(DaytonaConfigEnvSchema)(normalizeEnv(env)).pipe(
    Effect.flatMap((decodedEnv) =>
      Schema.decodeUnknown(DaytonaConfigSchema)({
        apiKey: decodedEnv.DAYTONA_API_KEY,
        apiUrl: decodedEnv.DAYTONA_API_URL,
        target: decodedEnv.DAYTONA_TARGET,
        snapshotName: decodedEnv.DAYTONA_SNAPSHOT ?? fallbackSnapshotName,
      }),
    ),
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new DaytonaConfigError({
          missingFields: missingConfigEnvFields(env, fallbackSnapshotName),
          details: ParseResult.TreeFormatter.formatErrorSync(error),
        }),
      ),
    ),
  );
