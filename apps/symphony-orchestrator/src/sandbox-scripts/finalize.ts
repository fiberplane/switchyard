import { Effect } from "effect";

import type { DaytonaAdapterShape } from "../daytona/daytona.adapter.js";
import type { DaytonaSandboxNotFoundError, DaytonaSandboxOpError } from "../daytona/errors.js";
import type { SandboxHandle } from "../daytona/models.js";
import { SandboxScriptError } from "./errors.js";
import type { FinalizeBundleOptions, SandboxBundleResult } from "./models.js";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

// Sentinel form for the count probe: bare positional parsing ("last numeric line
// of stdout") is fragile because `git bundle create` may write progress to stdout
// in some versions. The `__commits=` prefix gives us a stable line to grep for
// regardless of what bundle-create chose to print.
const COMMITS_SENTINEL = /^__commits=(\d+)$/m;

export const buildFinalizeScript = (options: FinalizeBundleOptions): string => {
  const repo = shellQuote(options.repoPath);
  const bundle = shellQuote(options.bundlePath);
  return [
    "set -euo pipefail",
    `cd ${repo}`,
    // `HEAD` (not `symphony-base..HEAD`) per ADR D7: the bundle is self-contained,
    // so the host can fetch it without sharing the base. ADR D6's single-commit-
    // history invariant means the empty-commit case naturally produces a valid
    // 1-commit bundle — no fallback branch needed.
    `git bundle create ${bundle} HEAD`,
    'echo "__commits=$(git rev-list --count symphony-base..HEAD)"',
  ].join("\n");
};

export const runFinalize = (
  adapter: DaytonaAdapterShape,
  handle: SandboxHandle,
  options: FinalizeBundleOptions,
): Effect.Effect<
  SandboxBundleResult,
  SandboxScriptError | DaytonaSandboxNotFoundError | DaytonaSandboxOpError
> =>
  Effect.gen(function* () {
    const command = buildFinalizeScript(options);
    const result = yield* adapter.executeCommand(handle, command);
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new SandboxScriptError({
          operation: "finalizeBundle",
          command,
          exitCode: result.exitCode,
          stderr: result.stderr,
        }),
      );
    }
    const match = COMMITS_SENTINEL.exec(result.stdout);
    if (match === null) {
      return yield* Effect.fail(
        new SandboxScriptError({
          operation: "finalizeBundle",
          command,
          exitCode: result.exitCode,
          stderr: `missing __commits=<n> sentinel in stdout: ${result.stdout}`,
        }),
      );
    }
    return {
      bundlePath: options.bundlePath,
      commitsBeyondBase: Number(match[1]),
    };
  });
