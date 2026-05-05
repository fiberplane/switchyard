import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { NodeContext } from "@effect/platform-node";
import { Effect, Schema } from "effect";

import { FpAdapter, FpAdapterLive } from "../../src/fp/adapter.js";
import { FpBinary, FpBinaryLive } from "../../src/fp/binary.js";
import { FpService, FpServiceLive } from "../../src/fp/service.js";
import {
  type FpTestProject,
  runFpSuccess,
  setupFpProject,
} from "./test-helpers/setup-fp-project.js";

const SeedIssueSchema = Schema.Struct({
  id: Schema.String,
  shortId: Schema.String,
  displayId: Schema.String,
  title: Schema.String,
  status: Schema.String,
  parent: Schema.NullOr(Schema.String),
});

type SeedIssue = Schema.Schema.Type<typeof SeedIssueSchema>;

let project: FpTestProject;
let readyIssue: SeedIssue;
let notReadyIssue: SeedIssue;

const seedIssue = async (
  title: string,
  ready: "true" | "false",
  symphonyState: "idle" | "needs-attention",
): Promise<SeedIssue> => {
  const output = await runFpSuccess(project, [
    "issue",
    "create",
    "--title",
    title,
    "--description",
    `seed for fp service integration (ready=${ready}, state=${symphonyState})`,
    "--property",
    `symphony_ready=${ready}`,
    "--property",
    `symphony_state=${symphonyState}`,
    "--format",
    "json",
  ]);
  return Effect.runPromise(Schema.decodeUnknown(Schema.parseJson(SeedIssueSchema))(output));
};

beforeAll(async () => {
  const fpPath = await Effect.runPromise(
    Effect.gen(function* () {
      const fpBinary = yield* FpBinary;
      return yield* fpBinary.resolve();
    }).pipe(Effect.provide(FpBinaryLive()), Effect.provide(NodeContext.layer)),
  );
  project = await setupFpProject(fpPath);
  readyIssue = await seedIssue("symphony service ready", "true", "idle");
  notReadyIssue = await seedIssue("symphony service not ready", "false", "idle");
});

afterAll(async () => {
  await project?.cleanup();
});

const runWithService = <A, E>(effect: Effect.Effect<A, E, FpService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(FpServiceLive),
      Effect.provide(FpAdapterLive({ cwd: project.projectDir, env: project.env })),
      Effect.provide(FpBinaryLive({ env: project.env })),
      Effect.provide(NodeContext.layer),
    ),
  );

describe("FpService — real fp integration smoke", () => {
  test("fetchCandidates returns only the ready issue", async () => {
    const result = await runWithService(
      Effect.gen(function* () {
        const service = yield* FpService;
        return yield* service.fetchCandidates(new Set());
      }),
    );

    const eligibleIds = result.eligible.map((entry) => entry.detail.id);
    expect(eligibleIds).toContain(readyIssue.id);
    expect(eligibleIds).not.toContain(notReadyIssue.id);

    const notReadyRejection = result.rejected.find((entry) => entry.id === notReadyIssue.id);
    expect(notReadyRejection?.reason).toBe("not-ready");
  });

  test("claimIssue → markCompleted lands status + symphony_state in atomic writes", async () => {
    const claimable = await seedIssue("symphony service claim+complete", "true", "idle");

    await runWithService(
      Effect.gen(function* () {
        const service = yield* FpService;
        yield* service.claimIssue(claimable.displayId);
      }),
    );

    const afterClaim = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* FpAdapter;
        return yield* adapter.showIssue(claimable.displayId);
      }).pipe(
        Effect.provide(FpAdapterLive({ cwd: project.projectDir, env: project.env })),
        Effect.provide(FpBinaryLive({ env: project.env })),
        Effect.provide(NodeContext.layer),
      ),
    );
    expect(afterClaim.status).toBe("in-progress");
    expect(afterClaim.properties.symphony_state).toBe("active");

    await runWithService(
      Effect.gen(function* () {
        const service = yield* FpService;
        yield* service.markCompleted(claimable.displayId, "service smoke summary");
      }),
    );

    const afterDone = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* FpAdapter;
        return yield* adapter.showIssue(claimable.displayId);
      }).pipe(
        Effect.provide(FpAdapterLive({ cwd: project.projectDir, env: project.env })),
        Effect.provide(FpBinaryLive({ env: project.env })),
        Effect.provide(NodeContext.layer),
      ),
    );
    expect(afterDone.status).toBe("done");
    expect(afterDone.properties.symphony_state).toBe("end");
    expect(afterDone.comments.length).toBeGreaterThan(0);
  });
});
