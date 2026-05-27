import { Daytona, type CreateSandboxFromSnapshotParams } from "@daytona/sdk";
import { Config, Context, Data, Effect, Layer, Schema } from "effect";

class DaytonaConfigError extends Data.TaggedError("DaytonaConfigError")<{
  readonly reason: string;
}> {}

class SandboxPlanError extends Data.TaggedError("SandboxPlanError")<{
  readonly reason: string;
}> {}

const FpIssue = Schema.Struct({
  id: Schema.String,
  displayId: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  status: Schema.Literal("todo", "in-progress", "done"),
  parent: Schema.NullOr(Schema.String),
  dependencies: Schema.Array(Schema.String),
  properties: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

type FpIssue = Schema.Schema.Type<typeof FpIssue>;

interface SandboxDispatchPlan {
  readonly sandbox: CreateSandboxFromSnapshotParams;
  readonly repoPath: string;
  readonly setupCommand: string;
  readonly runCommand: string;
  readonly collectCommand: string;
}

interface DaytonaSandboxPlannerService {
  readonly plan: (issue: FpIssue) => Effect.Effect<SandboxDispatchPlan, SandboxPlanError>;
}

class DaytonaSandboxPlanner extends Context.Tag("DaytonaSandboxPlanner")<
  DaytonaSandboxPlanner,
  DaytonaSandboxPlannerService
>() {}

const plannerLayer = Layer.effect(
  DaytonaSandboxPlanner,
  Effect.gen(function* () {
    const snapshot = yield* Config.string("DAYTONA_SNAPSHOT").pipe(
      Config.withDefault("symphony-codex-bun"),
    );
    const repoPath = yield* Config.string("SYMPHONY_SANDBOX_REPO").pipe(
      Config.withDefault("/workspace/repo"),
    );

    return {
      plan: (issue) =>
        Effect.gen(function* () {
          const ready = issue.properties["symphony_ready"];
          if (issue.status !== "todo") {
            return yield* Effect.fail(
              new SandboxPlanError({ reason: `Issue is ${issue.status}, not todo` }),
            );
          }
          if (String(ready) !== "true") {
            return yield* Effect.fail(
              new SandboxPlanError({ reason: "Issue is missing symphony_ready=true" }),
            );
          }
          if (issue.dependencies.length > 0) {
            return yield* Effect.fail(
              new SandboxPlanError({ reason: "Issue still has dependencies" }),
            );
          }

          const sandboxName = `symphony-${issue.displayId.toLowerCase()}`;
          return {
            sandbox: {
              name: sandboxName,
              snapshot,
              language: "typescript",
              autoStopInterval: 15,
              autoDeleteInterval: -1,
              envVars: {
                SYMPHONY_ISSUE_ID: issue.id,
                SYMPHONY_ISSUE_DISPLAY_ID: issue.displayId,
              },
              labels: {
                app: "symphony",
                issue: issue.displayId,
                role: "codex-runner",
              },
            },
            repoPath,
            setupCommand: `mkdir -p ${repoPath} && tar -xzf /tmp/repo.tgz -C ${repoPath} && cd ${repoPath} && git init && git add . && git commit -m "base" && git tag symphony-base`,
            runCommand: `cd ${repoPath} && codex exec --dangerously-bypass-approvals-and-sandbox < /tmp/prompt.md`,
            collectCommand: `cd ${repoPath} && git diff --binary symphony-base > /tmp/result.patch`,
          } satisfies SandboxDispatchPlan;
        }),
    };
  }),
);

const makeDaytonaClient = Effect.gen(function* () {
  const apiKey = yield* Config.string("DAYTONA_API_KEY").pipe(Config.option);
  const apiUrl = yield* Config.string("DAYTONA_API_URL").pipe(Config.option);
  const target = yield* Config.string("DAYTONA_TARGET").pipe(Config.option);

  if (apiKey._tag === "None") {
    return yield* Effect.fail(
      new DaytonaConfigError({
        reason: "DAYTONA_API_KEY is required before creating a real sandbox",
      }),
    );
  }

  return new Daytona({
    apiKey: apiKey.value,
    ...(apiUrl._tag === "Some" ? { apiUrl: apiUrl.value } : {}),
    ...(target._tag === "Some" ? { target: target.value } : {}),
  });
});

const sampleIssue: unknown = {
  id: "issue_123",
  displayId: "SWYRD-demo",
  title: "Build dashboard shell",
  description: "Create the first dashboard slice.",
  status: "todo",
  parent: null,
  dependencies: [],
  properties: {
    symphony_ready: "true",
  },
};

const program = Effect.gen(function* () {
  const issue = yield* Schema.decodeUnknown(FpIssue)(sampleIssue);
  const planner = yield* DaytonaSandboxPlanner;
  const plan = yield* planner.plan(issue);

  const clientResult = yield* makeDaytonaClient.pipe(Effect.either);

  return {
    plan,
    canCreateClient: clientResult._tag === "Right",
    clientCheck:
      clientResult._tag === "Right"
        ? "Daytona client constructed"
        : clientResult.left instanceof DaytonaConfigError
          ? clientResult.left.reason
          : String(clientResult.left),
  };
}).pipe(Effect.provide(plannerLayer));

console.log(await Effect.runPromise(program));
