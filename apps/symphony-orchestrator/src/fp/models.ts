import { Schema } from "effect";

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
  priority: Schema.NullOr(FpIssuePrioritySchema),
  parent: Schema.NullOr(Schema.String),
  dependencies: Schema.Array(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type FpIssue = Schema.Schema.Type<typeof FpIssueSchema>;

export const FpIssueListSchema = Schema.Struct({
  issues: Schema.Array(FpIssueSchema),
});
export type FpIssueList = Schema.Schema.Type<typeof FpIssueListSchema>;
