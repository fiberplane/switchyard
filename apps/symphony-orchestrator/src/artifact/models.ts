import { Schema } from "effect";

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
