import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { GitAdapter, GitAdapterLive } from "../../src/integration/git.adapter.js";
import { IntegrationService, IntegrationServiceLive } from "../../src/integration/service.js";
import { headSha, setupHostRepo, type HostRepo } from "./test-helpers/host-repo.js";

let host: HostRepo;

beforeEach(async () => {
  host = await setupHostRepo();
});

afterEach(async () => {
  await host?.cleanup();
});

const layer = () =>
  Layer.provide(
    IntegrationServiceLive,
    Layer.merge(GitAdapterLive({ cwd: host.dir, env: host.env }), NodeContext.layer),
  );

const runWithService = <A, E>(effect: Effect.Effect<A, E, IntegrationService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer()), Effect.provide(NodeContext.layer)));

describe("IntegrationService.prepareSourceHandoff", () => {
  test("returns baseRev matching HEAD and a tar.gz archive containing tracked files", async () => {
    const expected = await headSha(host.dir);

    const handoff = await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.prepareSourceHandoff();
      }),
    );

    expect(handoff.kind).toBe("archive");
    if (handoff.kind !== "archive") {
      return;
    }
    expect(handoff.baseRev).toBe(expected);
    expect(handoff.archivePath.startsWith(tmpdir())).toBe(true);
    expect(await Bun.file(handoff.archivePath).exists()).toBe(true);

    const listing = (await Bun.$`tar -tzf ${handoff.archivePath}`.text()).split("\n");
    expect(listing).toContain("README.md");
    expect(listing).toContain("src.ts");

    expect(handoff.archivePath.endsWith(".tar.gz")).toBe(true);
    // archivePath is under os.tmpdir() — caller owns cleanup; remove to avoid leaking.
    await Bun.$`rm -f ${handoff.archivePath}`;
  });
});

describe("IntegrationService.prepareGithubCloneSourceHandoff", () => {
  test("pins baseSha from the remote branch instead of local HEAD", async () => {
    const localHead = await headSha(host.dir);
    const remoteSha = "0123456789abcdef0123456789abcdef01234567";
    const calls: Array<{
      readonly repoUrl: string;
      readonly branch: string;
      readonly token?: string | undefined;
    }> = [];

    const mockGit = Layer.succeed(GitAdapter, {
      revParse: () => Effect.succeed(localHead),
      lsRemoteHead: (repoUrl, branch, token) =>
        Effect.sync(() => {
          calls.push({ repoUrl, branch, token });
          return `${remoteSha}\trefs/heads/${branch}\n`;
        }),
      archive: () => Effect.void,
      fetchBundle: () => Effect.void,
      branchExists: () => Effect.succeed(false),
      branchCreate: () => Effect.void,
      revListCount: () => Effect.succeed(1),
    });

    const handoff = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.prepareGithubCloneSourceHandoff({
          repoUrl: "https://github.com/fiberplane/switchyard.git",
          baseBranch: "main",
          repoPath: "/workspace/repo",
          branchName: "symphony/SWYRD-test",
          githubToken: "github-token-that-must-not-render",
        });
      }).pipe(
        Effect.provide(
          Layer.provide(IntegrationServiceLive, Layer.merge(mockGit, NodeContext.layer)),
        ),
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(calls).toEqual([
      {
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        branch: "main",
        token: "github-token-that-must-not-render",
      },
    ]);
    expect(handoff.baseSha).toBe(remoteSha);
    expect(handoff.baseSha).not.toBe(localHead);
    expect(handoff.branchName).toBe("symphony/SWYRD-test");
  });
});
