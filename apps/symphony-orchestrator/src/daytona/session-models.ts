import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

export const DaytonaSessionExecuteResponseSchema = Schema.Struct({
  cmdId: NonEmptyString,
});
export type DaytonaSessionExecuteResponse = Schema.Schema.Type<
  typeof DaytonaSessionExecuteResponseSchema
>;
