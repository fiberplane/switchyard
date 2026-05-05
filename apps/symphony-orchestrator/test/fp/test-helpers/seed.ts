import { Effect, Schema } from "effect";

import { type FpTestProject, runFpSuccess } from "./setup-fp-project.js";

const FpCreatedIssueSchema = Schema.Struct({
  id: Schema.String,
  shortId: Schema.String,
  displayId: Schema.String,
  title: Schema.String,
  status: Schema.String,
  parent: Schema.NullOr(Schema.String),
});

export type SeededIssue = {
  readonly id: string;
  readonly shortId: string;
  readonly displayId: string;
  readonly title: string;
  readonly symphonyState: string;
};

export type SeededIssues = {
  readonly todoIdle: SeededIssue;
  readonly todoActive: SeededIssue;
  readonly todoNeedsAttention: SeededIssue;
};

const createSeedIssue = async (
  project: FpTestProject,
  title: string,
  symphonyState: string,
): Promise<SeededIssue> => {
  const output = await runFpSuccess(project, [
    "issue",
    "create",
    "--title",
    title,
    "--description",
    `Seed issue with symphony_state=${symphonyState}`,
    "--property",
    `symphony_state=${symphonyState}`,
    "--format",
    "json",
  ]);
  const issue = await Effect.runPromise(
    Schema.decodeUnknown(Schema.parseJson(FpCreatedIssueSchema))(output),
  );

  return {
    id: issue.id,
    shortId: issue.shortId,
    displayId: issue.displayId,
    title: issue.title,
    symphonyState,
  };
};

export const seedTestIssues = async (project: FpTestProject): Promise<SeededIssues> => ({
  todoIdle: await createSeedIssue(project, "symphony seed idle", "idle"),
  todoActive: await createSeedIssue(project, "symphony seed active", "active"),
  todoNeedsAttention: await createSeedIssue(
    project,
    "symphony seed needs attention",
    "needs-attention",
  ),
});
