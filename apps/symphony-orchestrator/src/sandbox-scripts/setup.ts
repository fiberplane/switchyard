import { Effect } from "effect";

import type { DaytonaAdapterShape } from "../daytona/daytona.adapter.js";
import type { DaytonaSandboxNotFoundError, DaytonaSandboxOpError } from "../daytona/errors.js";
import type { SandboxHandle } from "../daytona/models.js";
import { SandboxScriptError } from "./errors.js";
import type { SetupRepoOptions } from "./models.js";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

// Setup is non-idempotent by design: ADR D6 says one issue dispatches into one
// fresh sandbox, so a second `setupRepo` would hit `git tag` collisions on
// `symphony-base`. Callers must guarantee single-call.
export const buildSetupScript = (options: SetupRepoOptions): string => {
  const archive = shellQuote(options.archivePath);
  const repo = shellQuote(options.repoPath);
  const symphony = shellQuote(options.symphonyDir);
  return [
    "set -euo pipefail",
    `mkdir -p ${repo} ${symphony}`,
    `tar -xzf ${archive} -C ${repo}`,
    `cd ${repo}`,
    "git init -q",
    "git add .",
    'git commit -q -m "base"',
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
    return undefined;
  });
