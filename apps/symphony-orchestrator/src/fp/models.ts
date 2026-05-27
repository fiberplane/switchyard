import { Effect, ParseResult, Schema } from "effect";

import { FpDecodeError } from "./errors.js";

export const FpIssueStatusSchema = Schema.Literal("todo", "in-progress", "done");
export type FpIssueStatus = Schema.Schema.Type<typeof FpIssueStatusSchema>;

export const FpIssuePrioritySchema = Schema.Literal("low", "medium", "high", "critical");
export type FpIssuePriority = Schema.Schema.Type<typeof FpIssuePrioritySchema>;

export const FpIssueSchema = Schema.Struct({
  id: Schema.String,
  shortId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: FpIssueStatusSchema,
  priority: Schema.optionalWith(Schema.NullOr(FpIssuePrioritySchema), { default: () => null }),
  parent: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  dependencies: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  createdAt: Schema.optionalWith(Schema.String, { default: () => "" }),
  updatedAt: Schema.optionalWith(Schema.String, { default: () => "" }),
});
export type FpIssue = Schema.Schema.Type<typeof FpIssueSchema>;

export const FpIssueListSchema = Schema.Struct({
  issues: Schema.Array(FpIssueSchema),
});
export type FpIssueList = Schema.Schema.Type<typeof FpIssueListSchema>;

export const FpIssueDetailSchema = Schema.Struct({
  id: Schema.String,
  displayId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: FpIssueStatusSchema,
  priority: Schema.optionalWith(Schema.NullOr(FpIssuePrioritySchema), { default: () => null }),
  parent: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  dependencies: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  revisions: Schema.optionalWith(Schema.Array(Schema.Unknown), { default: () => [] }),
  author: Schema.optionalWith(Schema.String, { default: () => "" }),
  createdAt: Schema.optionalWith(Schema.String, { default: () => "" }),
  updatedAt: Schema.optionalWith(Schema.String, { default: () => "" }),
  properties: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Unknown }), {
    default: () => ({}),
  }),
  comments: Schema.optionalWith(Schema.Array(Schema.Unknown), { default: () => [] }),
});
export type FpIssueDetail = Schema.Schema.Type<typeof FpIssueDetailSchema>;

export const decodeFpIssueListJson = (
  content: string,
  path: string,
): Effect.Effect<readonly FpIssue[], FpDecodeError> =>
  Schema.decodeUnknown(Schema.parseJson(FpIssueListSchema))(content).pipe(
    Effect.map((list) => list.issues),
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new FpDecodeError({
          path,
          reason: "JSON/schema validation failed",
          details: ParseResult.TreeFormatter.formatErrorSync(error),
        }),
      ),
    ),
  );

export const decodeFpIssueDetailJson = (
  content: string,
  path: string,
): Effect.Effect<FpIssueDetail, FpDecodeError> =>
  Schema.decodeUnknown(Schema.parseJson(FpIssueDetailSchema))(content).pipe(
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new FpDecodeError({
          path,
          reason: "JSON/schema validation failed",
          details: ParseResult.TreeFormatter.formatErrorSync(error),
        }),
      ),
    ),
  );
