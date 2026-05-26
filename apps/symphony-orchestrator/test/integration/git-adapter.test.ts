import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { NodeContext } from "@effect/platform-node";
import { Effect, Either } from "effect";

import { GitCommandError } from "../../src/integration/errors.js";
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

describe("GitAdapter.lsRemoteHead", () => {
  test("disables ambient credential helpers for host remote probes", async () => {
    const binDir = join(host.dir, "fake-bin");
    const argsPath = join(host.dir, "ls-remote-args.txt");
    const gitPath = join(binDir, "git");
    await mkdir(binDir, { recursive: true });
    await Bun.write(
      gitPath,
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
        `test "$PWD" != ${JSON.stringify(host.dir)}`,
        'test "$GIT_ASKPASS" != "/tmp/ambient-askpass-that-must-not-run"',
        'test "$GITHUB_TOKEN" != "ambient-token-that-must-not-flow"',
        'test "$GH_TOKEN" != "ambient-gh-token-that-must-not-flow"',
        'test "$GIT_CONFIG_GLOBAL" != "/tmp/ambient-global-gitconfig-that-must-not-apply"',
        'test "$GIT_CONFIG_COUNT" = "0"',
        'if [ "$1" = "-c" ] && [ "$2" = "credential.helper=" ] && [ "$3" = "ls-remote" ]; then',
        "  printf '%s\\t%s\\n' 0123456789abcdef0123456789abcdef01234567 refs/heads/main",
        "  exit 0",
        "fi",
        "exit 42",
        "",
      ].join("\n"),
    );
    await chmod(gitPath, 0o700);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitAdapter;
        return yield* git.lsRemoteHead("https://github.com/fiberplane/switchyard.git", "main");
      }).pipe(
        Effect.provide(
          GitAdapterLive({
            cwd: host.dir,
            env: {
              ...host.env,
              PATH: `${binDir}:${process.env.PATH ?? ""}`,
              GIT_CONFIG_GLOBAL: "/tmp/ambient-global-gitconfig-that-must-not-apply",
              GIT_CONFIG_COUNT: "2",
              GIT_CONFIG_KEY_0: "url.https://token@example.invalid/.insteadOf",
              GIT_CONFIG_VALUE_0: "https://github.com/",
              GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
              GIT_CONFIG_VALUE_1: "AUTHORIZATION: bearer ambient",
              GIT_ASKPASS: "/tmp/ambient-askpass-that-must-not-run",
              GITHUB_TOKEN: "ambient-token-that-must-not-flow",
              GH_TOKEN: "ambient-gh-token-that-must-not-flow",
            },
          }),
        ),
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(result.trim()).toBe("0123456789abcdef0123456789abcdef01234567\trefs/heads/main");
    expect(await Bun.file(argsPath).text()).toContain("-c\ncredential.helper=\nls-remote\n");
  });

  test("redacts scoped github token from ls-remote failures", async () => {
    const token = "github-token-that-must-not-render";
    const binDir = join(host.dir, "fake-bin");
    const gitPath = join(binDir, "git");
    await mkdir(binDir, { recursive: true });
    await Bun.write(
      gitPath,
      [
        "#!/usr/bin/env bash",
        'printf "remote rejected token %s\\n" "$GITHUB_TOKEN" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );
    await chmod(gitPath, 0o700);

    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const git = yield* GitAdapter;
          return yield* git.lsRemoteHead(
            "https://github.com/fiberplane/switchyard.git",
            "main",
            token,
          );
        }).pipe(
          Effect.provide(
            GitAdapterLive({
              cwd: host.dir,
              env: {
                ...host.env,
                PATH: `${binDir}:${process.env.PATH ?? ""}`,
              },
            }),
          ),
          Effect.provide(NodeContext.layer),
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(GitCommandError);
      expect(result.left.stderr).not.toContain(token);
      expect(result.left.message).not.toContain(token);
      expect(result.left.stderr).toContain("[redacted]");
    }
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
