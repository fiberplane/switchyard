import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";

import { GitAdapter, GitAdapterLive } from "../../src/integration/git.adapter.js";
import { headSha, setupHostRepo, type HostRepo } from "./test-helpers/host-repo.js";
import {
  sandboxAddCommit,
  sandboxCreateBundle,
  setupSandboxRepo,
  type SandboxRepo,
} from "./test-helpers/sandbox-repo.js";

let host: HostRepo;

beforeEach(async () => {
  host = await setupHostRepo();
});

afterEach(async () => {
  await host?.cleanup();
});

const runWithAdapter = <A, E>(effect: Effect.Effect<A, E, GitAdapter>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(GitAdapterLive({ cwd: host.dir, env: host.env })),
      Effect.provide(NodeContext.layer),
    ),
  );

describe("GitAdapter.revParse", () => {
  test("returns the SHA of HEAD on a freshly initialized repo", async () => {
    const expected = await headSha(host.dir);

    const result = await runWithAdapter(
      Effect.gen(function* () {
        const git = yield* GitAdapter;
        return yield* git.revParse("HEAD");
      }),
    );

    expect(result).toBe(expected);
  });
});

describe("GitAdapter.fetchBundle", () => {
  let sandbox: SandboxRepo;

  beforeEach(async () => {
    sandbox = await setupSandboxRepo();
  });

  afterEach(async () => {
    await sandbox?.cleanup();
  });

  test("populates the given refspec on the host repo", async () => {
    await sandboxAddCommit(sandbox, "worker.ts", "export const y = 2;\n", "worker change");
    const bundlePath = join(sandbox.dir, "out.bundle");
    await sandboxCreateBundle(sandbox, "HEAD", bundlePath);

    await runWithAdapter(
      Effect.gen(function* () {
        const git = yield* GitAdapter;
        yield* git.fetchBundle(bundlePath, "+HEAD:refs/symphony/ABC-123");
      }),
    );

    const refExists = (
      await Bun.$`git -C ${host.dir} show-ref --verify --quiet refs/symphony/ABC-123`
        .nothrow()
        .quiet()
    ).exitCode;
    expect(refExists).toBe(0);
  });
});

describe("GitAdapter.archive", () => {
  test("produces a tar.gz of tracked files at the given rev", async () => {
    const sha = await headSha(host.dir);
    const archivePath = join(host.dir, "archive.tar.gz");

    await runWithAdapter(
      Effect.gen(function* () {
        const git = yield* GitAdapter;
        yield* git.archive(sha, archivePath);
      }),
    );

    expect(await Bun.file(archivePath).exists()).toBe(true);
    const listing = (await Bun.$`tar -tzf ${archivePath}`.text()).split("\n");
    expect(listing).toContain("README.md");
    expect(listing).toContain("src.ts");
  });
});
