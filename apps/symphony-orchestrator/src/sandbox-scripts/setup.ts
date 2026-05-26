import { Effect } from "effect";

import type { DaytonaAdapterShape } from "../daytona/daytona.adapter.js";
import { DaytonaSandboxNotFoundError, DaytonaSandboxOpError } from "../daytona/errors.js";
import type { SandboxHandle } from "../daytona/models.js";
import { makeRedactor } from "../secrets/redactor.js";
import { SandboxScriptError } from "./errors.js";
import {
  SANDBOX_GIT_AUTHOR_EMAIL,
  SANDBOX_GIT_AUTHOR_NAME,
  type SetupCloneOptions,
  type SetupRepoOptions,
} from "./models.js";
import { shellQuote } from "./shell-quote.js";

const redactSandboxCommandError =
  (redact: (text: string) => string) =>
  (
    error: DaytonaSandboxNotFoundError | DaytonaSandboxOpError,
  ): DaytonaSandboxNotFoundError | DaytonaSandboxOpError => {
    switch (error._tag) {
      case "DaytonaSandboxNotFoundError":
        return new DaytonaSandboxNotFoundError({
          sandboxId: error.sandboxId,
          operation: error.operation,
          reason: redact(error.reason),
        });
      case "DaytonaSandboxOpError":
        return new DaytonaSandboxOpError({
          operation: error.operation,
          reason: redact(error.reason),
          ...(error.sandboxId === undefined ? {} : { sandboxId: error.sandboxId }),
        });
    }
  };

// Setup is non-idempotent by design: ADR D6 says one issue dispatches into one
// fresh sandbox, so a second `setupRepo` would hit `git tag` collisions on
// `symphony-base`. Callers must guarantee single-call.
export const buildSetupScript = (options: SetupRepoOptions): string => {
  const archive = shellQuote(options.archivePath);
  const repo = shellQuote(options.repoPath);
  const symphony = shellQuote(options.symphonyDir);
  // Stamp identity inline via `-c user.name`/`-c user.email` rather than
  // `git config --global` so the metadata is local to this commit and won't
  // mutate any global git state inside the sandbox.
  const authorName = shellQuote(SANDBOX_GIT_AUTHOR_NAME);
  const authorEmail = shellQuote(SANDBOX_GIT_AUTHOR_EMAIL);
  // We deliberately omit `git config --global --add safe.directory <repo>`.
  // The current Daytona base image runs `tar -xzf` and `git init` under the
  // same uid, so dubious-ownership refusal does not trigger. If a future image
  // runs sandbox commands as a different uid (e.g., separate exec user), add it
  // back as the first line under `cd ${repo}`. The smoke playground used it
  // because its exec context differs from the production sandbox.executeCommand.
  return [
    "set -euo pipefail",
    `mkdir -p ${repo} ${symphony}`,
    `tar -xzf ${archive} -C ${repo}`,
    `cd ${repo}`,
    "git init -q",
    "git add .",
    `git -c user.name=${authorName} -c user.email=${authorEmail} commit -q -m "base"`,
    "git tag symphony-base",
  ].join("\n");
};

export const runSetup = (
  adapter: DaytonaAdapterShape,
  handle: SandboxHandle,
  options: SetupRepoOptions,
): Effect.Effect<void, SandboxScriptError | DaytonaSandboxNotFoundError | DaytonaSandboxOpError> =>
  Effect.gen(function* () {
    const command = buildSetupScript(options);
    const result = yield* adapter.executeCommand(handle, command);
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new SandboxScriptError({
          operation: "setupRepo",
          command,
          exitCode: result.exitCode,
          stderr: result.stderr,
        }),
      );
    }
  }).pipe(
    Effect.withSpan("SandboxScriptService.setupRepo", {
      attributes: {
        archivePath: options.archivePath,
        repoPath: options.repoPath,
        symphonyDir: options.symphonyDir,
      },
    }),
  );

export const buildCloneSetupScript = (options: SetupCloneOptions): string => {
  const repoUrl = shellQuote(options.repoUrl);
  const baseBranch = shellQuote(options.baseBranch);
  const baseSha = shellQuote(options.baseSha);
  const repo = shellQuote(options.repoPath);
  const branchName = shellQuote(options.branchName);
  const symphony = shellQuote(options.symphonyDir);
  const branchRefspec = shellQuote(
    `refs/heads/${options.baseBranch}:refs/remotes/origin/${options.baseBranch}`,
  );
  const authorName = shellQuote(SANDBOX_GIT_AUTHOR_NAME);
  const authorEmail = shellQuote(SANDBOX_GIT_AUTHOR_EMAIL);

  return [
    "set -euo pipefail",
    "set +x",
    "umask 077",
    `git_global_config=${symphony}/gitconfig`,
    'export GIT_CONFIG_GLOBAL="$git_global_config"',
    "export GIT_CONFIG_SYSTEM=/dev/null",
    "export GIT_CONFIG_NOSYSTEM=1",
    "export GIT_CONFIG_COUNT=0",
    "unset GIT_CONFIG_PARAMETERS || true",
    "askpass=$(mktemp /tmp/swy-git-askpass.XXXXXX)",
    'cleanup() { rm -f "$askpass"; }',
    "trap cleanup EXIT",
    "cat > \"$askpass\" <<'SWY_ASKPASS'",
    "#!/usr/bin/env bash",
    'case "$1" in',
    "  *Username*) printf '%s\\n' x-access-token ;;",
    "  *Password*) printf '%s\\n' \"$GITHUB_TOKEN\" ;;",
    "  *) printf '\\n' ;;",
    "esac",
    "SWY_ASKPASS",
    'chmod 700 "$askpass"',
    `rm -rf ${repo}`,
    `mkdir -p "$(dirname ${repo})" ${symphony}`,
    `cat > ${symphony}/git-askpass <<'SWY_WORKER_ASKPASS'`,
    "#!/usr/bin/env bash",
    'case "$1" in',
    "  *Username*) printf '%s\\n' x-access-token ;;",
    "  *Password*) printf '%s\\n' \"$GITHUB_TOKEN\" ;;",
    "  *) printf '\\n' ;;",
    "esac",
    "SWY_WORKER_ASKPASS",
    `chmod 700 ${symphony}/git-askpass`,
    `mkdir -p ${symphony}/fp-rest`,
    `GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --no-checkout --filter=blob:none ${repoUrl} ${repo}`,
    `cd ${repo}`,
    `git config --global --add safe.directory ${repo}`,
    `git config --local user.name ${authorName}`,
    `git config --local user.email ${authorEmail}`,
    "git config --local --unset-all credential.helper || true",
    `GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git -c credential.helper= fetch --no-tags origin ${branchRefspec}`,
    `GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git -c credential.helper= fetch --no-tags origin ${baseSha}`,
    `git checkout --detach ${baseSha}`,
    `git remote set-url origin ${repoUrl}`,
    `test "$(git rev-parse HEAD)" = ${baseSha}`,
    `test "$(git remote get-url origin)" = ${repoUrl}`,
    `jq -n --arg repoUrl ${repoUrl} --arg baseBranch ${baseBranch} --arg baseSha ${baseSha} --arg repoPath ${repo} --arg branchName ${branchName} '{kind:"githubClone",repoUrl:$repoUrl,baseBranch:$baseBranch,baseSha:$baseSha,repoPath:$repoPath,branchName:$branchName}' > ${symphony}/source.json`,
  ].join("\n");
};

export const runSetupClone = (
  adapter: DaytonaAdapterShape,
  handle: SandboxHandle,
  options: SetupCloneOptions,
): Effect.Effect<void, SandboxScriptError | DaytonaSandboxNotFoundError | DaytonaSandboxOpError> =>
  Effect.gen(function* () {
    const command = buildCloneSetupScript(options);
    const redactor = makeRedactor([options.githubToken ?? ""]);
    const result = yield* adapter
      .executeCommand(handle, command, {
        env:
          options.githubToken === undefined
            ? { GITHUB_TOKEN: "", GIT_TERMINAL_PROMPT: "0" }
            : { GITHUB_TOKEN: options.githubToken, GIT_TERMINAL_PROMPT: "0" },
        timeoutSec: 300,
      })
      .pipe(Effect.mapError(redactSandboxCommandError(redactor.redact)));
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new SandboxScriptError({
          operation: "setupClone",
          command,
          exitCode: result.exitCode,
          stderr: redactor.redact(result.stderr),
        }),
      );
    }
  }).pipe(
    Effect.withSpan("SandboxScriptService.setupClone", {
      attributes: {
        repoPath: options.repoPath,
        symphonyDir: options.symphonyDir,
        repoUrl: options.repoUrl,
        baseBranch: options.baseBranch,
        baseSha: options.baseSha,
      },
    }),
  );
