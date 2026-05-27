import { describe, expect, test } from "bun:test";

import { Effect, Either } from "effect";

import type { DaytonaAdapterShape } from "../../src/daytona/daytona.adapter.js";
import { DaytonaSandboxOpError } from "../../src/daytona/errors.js";
import type { SandboxHandle } from "../../src/daytona/models.js";
import { SandboxScriptError } from "../../src/sandbox-scripts/errors.js";
import { buildFinalizeScript, runFinalize } from "../../src/sandbox-scripts/finalize.js";
import {
  SANDBOX_GIT_AUTHOR_EMAIL,
  SANDBOX_GIT_AUTHOR_NAME,
} from "../../src/sandbox-scripts/models.js";
import {
  buildCloneSetupScript,
  buildSetupScript,
  runSetup,
  runSetupClone,
} from "../../src/sandbox-scripts/setup.js";

describe("buildCloneSetupScript", () => {
  test("renders token-isolated GitHub clone setup without embedding the token", () => {
    const token = "github-token-that-must-not-render";
    const script = buildCloneSetupScript({
      repoUrl: "https://github.com/fiberplane/switchyard.git",
      baseBranch: "main",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
      repoPath: "/workspace/repo",
      branchName: "symphony/SWYRD-test",
      symphonyDir: "/tmp/.symphony",
      githubToken: token,
    });

    expect(script).not.toContain(token);
    expect(script).not.toContain("export GIT_CONFIG_GLOBAL=/dev/null");
    expect(script).toContain("git_global_config='/tmp/.symphony'/gitconfig");
    expect(script).toContain('export GIT_CONFIG_GLOBAL="$git_global_config"');
    expect(script).toContain("export GIT_CONFIG_SYSTEM=/dev/null");
    expect(script).toContain("export GIT_CONFIG_NOSYSTEM=1");
    expect(script).toContain("export GIT_CONFIG_COUNT=0");
    expect(script).toContain("unset GIT_CONFIG_PARAMETERS || true");
    expect(script).toContain("GIT_ASKPASS");
    expect(script).toContain("GIT_TERMINAL_PROMPT=0");
    expect(script).toContain("git -c credential.helper= clone");
    expect(script).toContain("git -c credential.helper= fetch");
    expect(script).toContain(
      "git -c credential.helper= fetch --no-tags origin '0123456789abcdef0123456789abcdef01234567'",
    );
    expect(script).toContain(
      "git remote set-url origin 'https://github.com/fiberplane/switchyard.git'",
    );
    expect(script).toContain("> '/tmp/.symphony'/source.json");
    expect(script).toContain("--arg branchName 'symphony/SWYRD-test'");
    expect(script).toContain('rm -f "$askpass"');
    expect(script).not.toContain('rm -f "$askpass" "$git_global_config"');
    expect(script).toContain('chmod 700 "$askpass"');
  });
});

describe("archive setup/finalize scripts", () => {
  const handle: SandboxHandle = { id: "sandbox-id", name: "sandbox", labels: {}, envVars: {} };

  test("renders deterministic archive setup without mutating global safe.directory", () => {
    const script = buildSetupScript({
      archivePath: "/tmp/repo.tgz",
      repoPath: "/workspace/repo",
      symphonyDir: "/tmp/.symphony",
    });

    expect(script).toContain("tar -xzf '/tmp/repo.tgz' -C '/workspace/repo'");
    expect(script).toContain("git init -q");
    expect(script).toContain(
      `git -c user.name='${SANDBOX_GIT_AUTHOR_NAME}' -c user.email='${SANDBOX_GIT_AUTHOR_EMAIL}' commit -q -m "base"`,
    );
    expect(script).toContain("git tag symphony-base");
    expect(script).not.toContain("safe.directory");
  });

  test("maps archive setup script failures to SandboxScriptError without live Daytona", async () => {
    const adapter: DaytonaAdapterShape = {
      assertSnapshot: () => Effect.void,
      createSandbox: () => Effect.dieMessage("unused"),
      deleteSandbox: () => Effect.void,
      executeCommand: () =>
        Effect.succeed({ exitCode: 2, stdout: "", stderr: "tar: missing archive" }),
      uploadFiles: () => Effect.void,
      downloadFiles: () => Effect.void,
    };

    const result = await Effect.runPromise(
      Effect.either(
        runSetup(adapter, handle, {
          archivePath: "/tmp/repo.tgz",
          repoPath: "/workspace/repo",
          symphonyDir: "/tmp/.symphony",
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) {
      return;
    }
    expect(result.left).toBeInstanceOf(SandboxScriptError);
    if (result.left instanceof SandboxScriptError) {
      expect(result.left.operation).toBe("setupRepo");
      expect(result.left.stderr).toContain("missing archive");
    }
  });

  test("parses finalize commit sentinel from the last matching stdout line", async () => {
    const adapter: DaytonaAdapterShape = {
      assertSnapshot: () => Effect.void,
      createSandbox: () => Effect.dieMessage("unused"),
      deleteSandbox: () => Effect.void,
      executeCommand: () =>
        Effect.succeed({
          exitCode: 0,
          stdout: "git progress\n__commits=1\nnoise\n__commits=2\n",
          stderr: "",
        }),
      uploadFiles: () => Effect.void,
      downloadFiles: () => Effect.void,
    };

    const result = await Effect.runPromise(
      runFinalize(adapter, handle, {
        repoPath: "/workspace/repo",
        bundlePath: "/tmp/.symphony/work.bundle",
      }),
    );

    expect(result).toEqual({
      bundlePath: "/tmp/.symphony/work.bundle",
      commitsBeyondBase: 2,
    });
  });

  test("fails finalize when the commit sentinel is absent", async () => {
    const adapter: DaytonaAdapterShape = {
      assertSnapshot: () => Effect.void,
      createSandbox: () => Effect.dieMessage("unused"),
      deleteSandbox: () => Effect.void,
      executeCommand: () => Effect.succeed({ exitCode: 0, stdout: "bundle created\n", stderr: "" }),
      uploadFiles: () => Effect.void,
      downloadFiles: () => Effect.void,
    };

    const result = await Effect.runPromise(
      Effect.either(
        runFinalize(adapter, handle, {
          repoPath: "/workspace/repo",
          bundlePath: "/tmp/.symphony/work.bundle",
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) {
      return;
    }
    expect(result.left).toBeInstanceOf(SandboxScriptError);
    if (result.left instanceof SandboxScriptError) {
      expect(result.left.operation).toBe("finalizeBundle");
      expect(result.left.stderr).toContain("missing __commits=<n> sentinel");
    }
  });

  test("renders finalize bundle command as the legacy self-contained bundle contract", () => {
    const script = buildFinalizeScript({
      repoPath: "/workspace/repo",
      bundlePath: "/tmp/.symphony/work.bundle",
    });

    expect(script).toContain("git bundle create '/tmp/.symphony/work.bundle' HEAD");
    expect(script).toContain('echo "__commits=$(git rev-list --count symphony-base..HEAD)"');
  });
});

test("clears ambient github token when clone setup is tokenless", async () => {
  const executeOptions: unknown[] = [];
  const adapter: DaytonaAdapterShape = {
    assertSnapshot: () => Effect.void,
    createSandbox: () => Effect.dieMessage("unused"),
    deleteSandbox: () => Effect.void,
    executeCommand: (_handle, _command, options) =>
      Effect.sync(() => {
        executeOptions.push(options);
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    uploadFiles: () => Effect.void,
    downloadFiles: () => Effect.void,
  };
  const handle: SandboxHandle = { id: "sandbox-id", name: "sandbox", labels: {}, envVars: {} };

  await Effect.runPromise(
    runSetupClone(adapter, handle, {
      repoUrl: "https://github.com/fiberplane/switchyard.git",
      baseBranch: "main",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
      repoPath: "/workspace/repo",
      branchName: "symphony/SWYRD-test",
      symphonyDir: "/tmp/.symphony",
    }),
  );

  expect(executeOptions).toEqual([
    {
      env: { GITHUB_TOKEN: "", GIT_TERMINAL_PROMPT: "0" },
      timeoutSec: 300,
    },
  ]);
});

test("redacts github token from clone setup failures", async () => {
  const token = "github-token-that-must-not-render";
  const adapter: DaytonaAdapterShape = {
    assertSnapshot: () => Effect.void,
    createSandbox: () => Effect.dieMessage("unused"),
    deleteSandbox: () => Effect.void,
    executeCommand: () =>
      Effect.succeed({
        exitCode: 128,
        stdout: "",
        stderr: `remote rejected ${token}`,
      }),
    uploadFiles: () => Effect.void,
    downloadFiles: () => Effect.void,
  };
  const handle: SandboxHandle = { id: "sandbox-id", name: "sandbox", labels: {}, envVars: {} };

  const result = await Effect.runPromise(
    Effect.either(
      runSetupClone(adapter, handle, {
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        baseBranch: "main",
        baseSha: "0123456789abcdef0123456789abcdef01234567",
        repoPath: "/workspace/repo",
        branchName: "symphony/SWYRD-test",
        symphonyDir: "/tmp/.symphony",
        githubToken: token,
      }),
    ),
  );

  expect(Either.isLeft(result)).toBe(true);
  if (Either.isRight(result)) {
    return;
  }
  expect(result.left).toBeInstanceOf(SandboxScriptError);
  if (result.left instanceof SandboxScriptError) {
    expect(result.left.stderr).not.toContain(token);
    expect(result.left.message).not.toContain(token);
  }
});

test("redacts github token from clone setup adapter errors", async () => {
  const token = "github-token-that-must-not-render";
  const adapter: DaytonaAdapterShape = {
    assertSnapshot: () => Effect.void,
    createSandbox: () => Effect.dieMessage("unused"),
    deleteSandbox: () => Effect.void,
    executeCommand: () =>
      Effect.fail(
        new DaytonaSandboxOpError({
          operation: "executeCommand",
          sandboxId: "sandbox-id",
          reason: `sdk rejected env GITHUB_TOKEN=${token}`,
        }),
      ),
    uploadFiles: () => Effect.void,
    downloadFiles: () => Effect.void,
  };
  const handle: SandboxHandle = { id: "sandbox-id", name: "sandbox", labels: {}, envVars: {} };

  const result = await Effect.runPromise(
    Effect.either(
      runSetupClone(adapter, handle, {
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        baseBranch: "main",
        baseSha: "0123456789abcdef0123456789abcdef01234567",
        repoPath: "/workspace/repo",
        branchName: "symphony/SWYRD-test",
        symphonyDir: "/tmp/.symphony",
        githubToken: token,
      }),
    ),
  );

  expect(Either.isLeft(result)).toBe(true);
  if (Either.isRight(result)) {
    return;
  }
  expect(result.left).toBeInstanceOf(DaytonaSandboxOpError);
  if (result.left instanceof DaytonaSandboxOpError) {
    expect(result.left.reason).not.toContain(token);
    expect(result.left.message).not.toContain(token);
  }
});
