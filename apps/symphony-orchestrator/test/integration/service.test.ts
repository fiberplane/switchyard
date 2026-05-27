import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { GitAdapter } from "../../src/integration/git.adapter.js";
import { IntegrationService, IntegrationServiceLive } from "../../src/integration/service.js";
import { headSha, setupHostRepo, type HostRepo } from "./test-helpers/host-repo.js";

let host: HostRepo;

beforeEach(async () => {
  host = await setupHostRepo();
});

afterEach(async () => {
  await host?.cleanup();
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
      lsRemoteHead: (repoUrl, branch, token) =>
        Effect.sync(() => {
          calls.push({ repoUrl, branch, token });
          return `${remoteSha}\trefs/heads/${branch}\n`;
        }),
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
