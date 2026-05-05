// Per-integration-test fp fixture: spins up a fresh fp project under a tmpdir
// and creates a single eligible symphony issue ready for the orchestrator to
// claim. Tears down the project + tmpdir on cleanup.
//
// Cycle 13a: this helper exists so service.integration.test.ts can drive a
// real `fp` binary against a real fp project without bleeding state between
// tests.

import { Schema } from "effect";

import { setupFpProject, runFpSuccess, type FpTestProject } from "../../fp/test-helpers/setup-fp-project.js";

const FpCreatedIssueSchema = Schema.Struct({
  id: Schema.String,
  displayId: Schema.String,
});

const decodeCreatedIssue = Schema.decodeUnknownSync(Schema.parseJson(FpCreatedIssueSchema));

export type SymphonyFpFixture = {
  readonly project: FpTestProject;
  readonly issueId: string;
  readonly displayId: string;
  readonly cleanup: () => Promise<void>;
};

export const createSymphonyFpFixture = async (
  fpPath: string,
  options: {
    readonly title?: string;
    readonly description?: string;
    readonly extraProperties?: Readonly<Record<string, string>>;
  } = {},
): Promise<SymphonyFpFixture> => {
  const project = await setupFpProject(fpPath);
  const propertyArgs: string[] = [];
  for (const [key, value] of Object.entries(options.extraProperties ?? {})) {
    propertyArgs.push("--property", `${key}=${value}`);
  }
  // Default symphony eligibility: ready=true, state=idle (the seed defaults
  // ensure ready becomes the gating property).
  propertyArgs.push("--property", "symphony_ready=true");
  propertyArgs.push("--property", "symphony_state=idle");

  const stdout = await runFpSuccess(project, [
    "issue",
    "create",
    "--title",
    options.title ?? "integration test issue",
    "--description",
    options.description ?? "Test issue created for orchestrator integration test",
    ...propertyArgs,
    "--format",
    "json",
  ]);
  const created = decodeCreatedIssue(stdout);

  return {
    project,
    issueId: created.id,
    displayId: created.displayId,
    cleanup: async () => {
      await project.cleanup();
    },
  };
};

// Re-arm an existing fp issue from `needs-attention` back into eligibility
// for cycle 13d. Sets symphony_state=idle, symphony_ready=true, status=todo.
// Deliberately does NOT touch symphony_attempt: the orchestrator reads the
// prior attempt and increments, and 13d's whole point is that the second
// dispatch lands on attempt=2. Resetting attempt would mask that contract.
export const rearmFpIssue = async (
  fixture: SymphonyFpFixture,
): Promise<void> => {
  await runFpSuccess(fixture.project, [
    "issue",
    "update",
    fixture.issueId,
    "--status",
    "todo",
    "--property",
    "symphony_ready=true",
    "--property",
    "symphony_state=idle",
  ]);
};
