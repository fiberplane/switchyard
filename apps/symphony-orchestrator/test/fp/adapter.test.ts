import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { NodeContext } from "@effect/platform-node";
import { Effect, Schema } from "effect";

import { FpAdapter, FpAdapterLive } from "../../src/fp/adapter.js";
import { FpBinaryLive } from "../../src/fp/binary.js";
import { FpIssueListSchema } from "../../src/fp/models.js";
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
});

describe("FpAdapter", () => {
  test("listIssuesByStatus returns raw fp stdout for a real project", async () => {
    const stdout = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* FpAdapter;
        return yield* adapter.listIssuesByStatus("todo");
      }),
    );

    expect(stdout.trim().startsWith("{")).toBe(true);
    expect(stdout).toContain(seeds.todoIdle.shortId);
  });
});
