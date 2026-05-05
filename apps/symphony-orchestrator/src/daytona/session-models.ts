import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

export const DaytonaSessionExecuteResponseSchema = Schema.Struct({
  cmdId: NonEmptyString,
});
export type DaytonaSessionExecuteResponse = Schema.Schema.Type<
  typeof DaytonaSessionExecuteResponseSchema
>;

export const DaytonaSessionCommandSchema = Schema.Struct({
  id: NonEmptyString,
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type DaytonaSessionCommand = Schema.Schema.Type<typeof DaytonaSessionCommandSchema>;
