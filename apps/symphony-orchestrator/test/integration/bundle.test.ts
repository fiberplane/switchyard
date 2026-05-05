import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { NodeContext } from "@effect/platform-node";
import { Effect, Either, Layer } from "effect";

import { BundleFetchError } from "../../src/integration/errors.js";
import { GitAdapterLive } from "../../src/integration/git.adapter.js";
import { IntegrationService, IntegrationServiceLive } from "../../src/integration/service.js";
import {
  branchExistsRaw,
  gitLogSubjects,
  setupHostRepo,
  type HostRepo,
} from "./test-helpers/host-repo.js";
import {
  sandboxAddCommit,
  sandboxCreateBundle,
  setupSandboxRepo,
  type SandboxRepo,
} from "./test-helpers/sandbox-repo.js";

let host: HostRepo;
let sandbox: SandboxRepo;

beforeEach(async () => {
  host = await setupHostRepo();
  sandbox = await setupSandboxRepo();
});

afterEach(async () => {
  await host?.cleanup();
  await sandbox?.cleanup();
});

const layer = () =>
  Layer.provide(
    IntegrationServiceLive,
    Layer.merge(GitAdapterLive({ cwd: host.dir, env: host.env }), NodeContext.layer),
  );

const runWithService = <A, E>(effect: Effect.Effect<A, E, IntegrationService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer()), Effect.provide(NodeContext.layer)));

const buildBundleWithThreeCommits = async (): Promise<string> => {
  await sandboxAddCommit(sandbox, "a.ts", "export const a = 1;\n", "first");
  await sandboxAddCommit(sandbox, "b.ts", "export const b = 2;\n", "second");
  await sandboxAddCommit(sandbox, "c.ts", "export const c = 3;\n", "third");
  const bundlePath = join(sandbox.dir, "out.bundle");
  await sandboxCreateBundle(sandbox, "HEAD", bundlePath);
  return bundlePath;
};

describe("IntegrationService.integrateBundle (empty bundle)", () => {
  test("returns commitsBeyondBase: 0 and creates the branch at symphony-base", async () => {
    // Sandbox bundled `symphony-base` alone: no worker commits.
    const bundlePath = join(sandbox.dir, "out.bundle");
    await sandboxCreateBundle(sandbox, "HEAD", bundlePath);

    const result = await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.integrateBundle(bundlePath, "EMPTY-1");
      }),
    );

    expect(result.branch).toBe("symphony/EMPTY-1");
    expect(result.commitsBeyondBase).toBe(0);
    expect(result.attempt).toBe(1);
    expect(await branchExistsRaw(host.dir, "symphony/EMPTY-1")).toBe(true);
  });
});

describe("IntegrationService.integrateBundle (branch collision)", () => {
  test("creates -attempt2 when symphony/<id> already exists", async () => {
    const bundlePath = await buildBundleWithThreeCommits();
    const firstResult = await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.integrateBundle(bundlePath, "ABC-123");
      }),
    );
    expect(firstResult.branch).toBe("symphony/ABC-123");
    const firstSubjects = await gitLogSubjects(host.dir, "symphony/ABC-123");

    const secondResult = await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.integrateBundle(bundlePath, "ABC-123");
      }),
    );

    expect(secondResult.branch).toBe("symphony/ABC-123-attempt2");
    expect(secondResult.attempt).toBe(2);
    // commitsBeyondBase must reflect the bundle's worker contribution, not host
    // branch state. Earlier formulations using `--not --branches` returned 0 here.
    expect(secondResult.commitsBeyondBase).toBe(3);
    expect(await branchExistsRaw(host.dir, "symphony/ABC-123")).toBe(true);
    expect(await branchExistsRaw(host.dir, "symphony/ABC-123-attempt2")).toBe(true);
    // First branch must be unchanged.
    const firstSubjectsAfter = await gitLogSubjects(host.dir, "symphony/ABC-123");
    expect(firstSubjectsAfter).toEqual(firstSubjects);
  });

  test("creates -attempt3 when both symphony/<id> and -attempt2 exist", async () => {
    const bundlePath = await buildBundleWithThreeCommits();

    for (let i = 0; i < 2; i += 1) {
      await runWithService(
        Effect.gen(function* () {
          const service = yield* IntegrationService;
          return yield* service.integrateBundle(bundlePath, "ABC-123");
        }),
      );
    }

    const thirdResult = await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.integrateBundle(bundlePath, "ABC-123");
      }),
    );

    expect(thirdResult.branch).toBe("symphony/ABC-123-attempt3");
    expect(thirdResult.attempt).toBe(3);
    expect(await branchExistsRaw(host.dir, "symphony/ABC-123")).toBe(true);
    expect(await branchExistsRaw(host.dir, "symphony/ABC-123-attempt2")).toBe(true);
    expect(await branchExistsRaw(host.dir, "symphony/ABC-123-attempt3")).toBe(true);
  });
});

describe("IntegrationService.integrateBundle (corrupt bundle)", () => {
  test("surfaces BundleFetchError when the bundle file is not a valid git bundle", async () => {
    const bundlePath = join(sandbox.dir, "fake.bundle");
    await Bun.write(bundlePath, "this is not a real git bundle\n");

    const outcome = await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* Effect.either(service.integrateBundle(bundlePath, "BAD-1"));
      }),
    );

    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toBeInstanceOf(BundleFetchError);
      expect((outcome.left as BundleFetchError).bundlePath).toBe(bundlePath);
      expect((outcome.left as BundleFetchError).stderr).not.toBe("");
    }
  });
});

describe("IntegrationService.integrateBundle (forensic suffix)", () => {
  test("creates symphony/<id>-incomplete when suffix='incomplete'", async () => {
    const bundlePath = await buildBundleWithThreeCommits();

    const result = await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.integrateBundle(bundlePath, "ABC-123", { suffix: "incomplete" });
      }),
    );

    expect(result.branch).toBe("symphony/ABC-123-incomplete");
    expect(result.attempt).toBe(1);
    expect(await branchExistsRaw(host.dir, "symphony/ABC-123-incomplete")).toBe(true);
  });

  test("collision under suffix scope produces -incomplete-attempt2", async () => {
    const bundlePath = await buildBundleWithThreeCommits();

    await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.integrateBundle(bundlePath, "ABC-123", { suffix: "incomplete" });
      }),
    );

    const second = await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.integrateBundle(bundlePath, "ABC-123", { suffix: "incomplete" });
      }),
    );

    expect(second.branch).toBe("symphony/ABC-123-incomplete-attempt2");
    expect(second.attempt).toBe(2);
    expect(await branchExistsRaw(host.dir, "symphony/ABC-123-incomplete-attempt2")).toBe(true);
  });
});

describe("IntegrationService.integrateBundle (happy path)", () => {
  test("creates symphony/<issueId> branch with all worker commits in order", async () => {
    const bundlePath = await buildBundleWithThreeCommits();

    const result = await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.integrateBundle(bundlePath, "ABC-123");
      }),
    );

    expect(result.branch).toBe("symphony/ABC-123");
    expect(result.commitsBeyondBase).toBe(3);
    expect(result.attempt).toBe(1);

    expect(await branchExistsRaw(host.dir, "symphony/ABC-123")).toBe(true);
    const subjects = await gitLogSubjects(host.dir, "symphony/ABC-123");
    expect(subjects.slice(0, 3)).toEqual(["third", "second", "first"]);
  });
});
