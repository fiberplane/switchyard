import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { NodeContext } from "@effect/platform-node";
import { Effect, Schema } from "effect";

import { FpAdapter, FpAdapterLive } from "../../src/fp/adapter.js";
import { FpBinary, FpBinaryLive } from "../../src/fp/binary.js";
import {
  type FpTestProject,
  runFpSuccess,
  setupFpProject,
} from "./test-helpers/setup-fp-project.js";

let project: FpTestProject;

const ScratchIssueSchema = Schema.Struct({
  id: Schema.String,
  shortId: Schema.String,
  displayId: Schema.String,
  title: Schema.String,
  status: Schema.String,
  parent: Schema.NullOr(Schema.String),
});

beforeAll(async () => {
  const fpPath = await Effect.runPromise(
    Effect.gen(function* () {
      const fpBinary = yield* FpBinary;
      return yield* fpBinary.resolve();
    }).pipe(Effect.provide(FpBinaryLive()), Effect.provide(NodeContext.layer)),
  );
  project = await setupFpProject(fpPath);
});

afterAll(async () => {
  await project?.cleanup();
});

const runWithAdapter = <A, E>(effect: Effect.Effect<A, E, FpAdapter>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(FpAdapterLive({ cwd: project.projectDir, env: project.env })),
      Effect.provide(FpBinaryLive({ env: project.env })),
      Effect.provide(NodeContext.layer),
    ),
  );

const createScratchIssue = async (title: string) => {
  const output = await runFpSuccess(project, [
    "issue",
    "create",
    "--title",
    title,
    "--description",
    "scratch issue for fp adapter updateIssue test",
    "--format",
    "json",
  ]);

  return Effect.runPromise(Schema.decodeUnknown(Schema.parseJson(ScratchIssueSchema))(output));
};

describe("FpAdapter.updateIssue", () => {
  test("lands status, property, and comment in a single fp invocation", async () => {
    const scratch = await createScratchIssue(`scratch updateIssue ${crypto.randomUUID()}`);

    const detail = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* FpAdapter;
        yield* adapter.updateIssue(scratch.displayId, {
          status: "in-progress",
          properties: { symphony_state: "active", symphony_attempt: "1" },
          comment: "Claimed by orchestrator",
        });
        return yield* adapter.showIssue(scratch.displayId);
      }),
    );

    expect(detail.status).toBe("in-progress");
    expect(detail.properties.symphony_state).toBe("active");
    expect(detail.properties.symphony_attempt).toBe("1");
    expect(detail.comments.length).toBeGreaterThan(0);
  });

  test("empty input is a no-op (no fp invocation, returns void)", async () => {
    const scratch = await createScratchIssue(`scratch updateIssue noop ${crypto.randomUUID()}`);

    await expect(
      runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* FpAdapter;
          return yield* adapter.updateIssue(scratch.displayId, {});
        }),
      ),
    ).resolves.toBeUndefined();

    const detail = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* FpAdapter;
        return yield* adapter.showIssue(scratch.displayId);
      }),
    );
    expect(detail.status).toBe("todo");
  });
});
