import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { NodeContext } from "@effect/platform-node";
import { Effect, Schema } from "effect";

import { FpAdapter, FpAdapterLive } from "../../src/fp/adapter.js";
import { FpBinaryLive } from "../../src/fp/binary.js";
import { FpIssueDetailSchema, FpIssueListSchema } from "../../src/fp/models.js";
import {
  type FpTestProject,
  setupFpProject,
} from "./test-helpers/setup-fp-project.js";
import { type SeededIssues, seedTestIssues } from "./test-helpers/seed.js";

const fixturePath = (name: string) => `test/fixtures/fp/${name}`;

let project: FpTestProject;
let seeds: SeededIssues;

beforeAll(async () => {
  project = await setupFpProject();
  seeds = await seedTestIssues(project);
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

describe("FpIssueListSchema", () => {
  test("decodes the recorded issue list fixture", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(FpIssueListSchema)(await Bun.file(fixturePath("issue-list.json")).json()),
    );

    expect(decoded.issues).toHaveLength(1);
    expect(decoded.issues[0]?.shortId).toBe("xyfynabp");
    expect(decoded.issues[0]?.status).toBe("in-progress");
  });

  test("decodes the recorded issue show fixture", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(FpIssueDetailSchema)(await Bun.file(fixturePath("issue-show.json")).json()),
    );

    expect(decoded.displayId).toBe("SWY-lutdubtu");
    expect(decoded.properties.symphony_state).toBe("idle");
  });
});

describe("FpAdapter", () => {
  test("listIssuesByStatus returns schema-decoded issues for a real project", async () => {
    const issues = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* FpAdapter;
        return yield* adapter.listIssuesByStatus("todo");
      }),
    );
    const seed = issues.find((issue) => issue.shortId === seeds.todoIdle.shortId);

    expect(seed?.title).toBe(seeds.todoIdle.title);
    expect(seed?.status).toBe("todo");
  });

  test("showIssue returns issue detail with custom properties", async () => {
    const detail = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* FpAdapter;
        return yield* adapter.showIssue(seeds.todoIdle.displayId);
      }),
    );

    expect(detail.displayId).toBe(seeds.todoIdle.displayId);
    expect(detail.properties.symphony_state).toBe(seeds.todoIdle.symphonyState);
  });
});
