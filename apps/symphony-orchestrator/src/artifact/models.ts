import { Effect, ParseResult, Schema } from "effect";

import { ArtifactDecodeError } from "./errors.js";

export const WorkerStatusSchema = Schema.Literal(
  "completed",
  "blocked",
  "needs-human",
  "failed",
);
export type WorkerStatus = Schema.Schema.Type<typeof WorkerStatusSchema>;

export const WorkerOutcomeSchema = Schema.Struct({
  status: WorkerStatusSchema,
  summary: Schema.String,
});
export type WorkerOutcome = Schema.Schema.Type<typeof WorkerOutcomeSchema>;

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
