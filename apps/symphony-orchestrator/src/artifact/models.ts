import { Effect, ParseResult, Schema } from "effect";

import { ArtifactDecodeError } from "./errors.js";

export const WorkerStatusSchema = Schema.Literal("completed", "blocked", "needs-human", "failed");
export type WorkerStatus = Schema.Schema.Type<typeof WorkerStatusSchema>;

export const WorkerOutcomeSchema = Schema.Struct({
  status: WorkerStatusSchema,
  summary: Schema.String,
});
export type WorkerOutcome = Schema.Schema.Type<typeof WorkerOutcomeSchema>;

export const OrchestratorStatusSchema = Schema.Literal("integrated", "needs-attention");
export type OrchestratorStatus = Schema.Schema.Type<typeof OrchestratorStatusSchema>;

export const OrchestratorRecordSchema = Schema.Struct({
  status: OrchestratorStatusSchema,
  branch: Schema.String,
  baseRev: Schema.String,
  workerStatus: Schema.OptionFromNullOr(WorkerStatusSchema),
  integrationError: Schema.optional(Schema.String),
  startedAt: Schema.String,
  endedAt: Schema.String,
  attempt: Schema.Number.pipe(Schema.int(), Schema.positive()),
});
export type OrchestratorRecord = Schema.Schema.Type<typeof OrchestratorRecordSchema>;
export type OrchestratorRecordEncoded = Schema.Schema.Encoded<typeof OrchestratorRecordSchema>;

export const decodeWorkerOutcome = (
  value: unknown,
  path: string,
): Effect.Effect<WorkerOutcome, ArtifactDecodeError> =>
  Schema.decodeUnknown(WorkerOutcomeSchema)(value).pipe(
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new ArtifactDecodeError({
          path,
          reason: "schema validation failed",
          details: ParseResult.TreeFormatter.formatErrorSync(error),
        }),
      ),
    ),
  );

export const decodeOrchestratorRecord = (
  value: unknown,
  path: string,
): Effect.Effect<OrchestratorRecord, ArtifactDecodeError> =>
  Schema.decodeUnknown(OrchestratorRecordSchema)(value).pipe(
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new ArtifactDecodeError({
          path,
          reason: "schema validation failed",
          details: ParseResult.TreeFormatter.formatErrorSync(error),
        }),
      ),
    ),
  );

export const decodeOrchestratorRecordJson = (
  content: string,
  path: string,
): Effect.Effect<OrchestratorRecord, ArtifactDecodeError> =>
  Schema.decodeUnknown(Schema.parseJson(OrchestratorRecordSchema))(content).pipe(
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new ArtifactDecodeError({
          path,
          reason: "JSON/schema validation failed",
          details: ParseResult.TreeFormatter.formatErrorSync(error),
        }),
      ),
    ),
  );

export const encodeOrchestratorRecord = (
  record: OrchestratorRecord,
  path: string,
): Effect.Effect<OrchestratorRecordEncoded, ArtifactDecodeError> =>
  Schema.encode(OrchestratorRecordSchema)(record).pipe(
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new ArtifactDecodeError({
          path,
          reason: "schema encoding failed",
          details: ParseResult.TreeFormatter.formatErrorSync(error),
        }),
      ),
    ),
  );
