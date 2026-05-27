import { describe, expect, test } from "bun:test";

import { Effect, Either } from "effect";

import type { DaytonaAdapterShape } from "../../src/daytona/daytona.adapter.js";
import { DaytonaSandboxOpError } from "../../src/daytona/errors.js";
import type { SandboxHandle } from "../../src/daytona/models.js";
import { SandboxScriptError } from "../../src/sandbox-scripts/errors.js";
import { buildCloneSetupScript, runSetupClone } from "../../src/sandbox-scripts/setup.js";

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
