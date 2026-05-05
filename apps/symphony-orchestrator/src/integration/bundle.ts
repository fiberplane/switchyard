import { Effect } from "effect";

import { GitCommandError, type BundleFetchError } from "./errors.js";
import type { GitAdapterShape } from "./git.adapter.js";
import {
  symphonyBranchName,
  symphonyRefName,
  symphonyRefspec,
  type IntegrationResult,
} from "./models.js";

export type IntegrateBundleOptions = {
  readonly suffix?: string;
};

// Hard cap on the collision-suffix search loop. Per ADR D6 a normal run finishes
// after attempt=1 or 2; anything past this is a corrupt-state defect, not a normal
// retry. Surfacing it as a typed error lets the orchestrator route to needs-attention
// rather than wedging.
const MAX_BRANCH_SEARCH_ATTEMPTS = 1000;

const findFreeBranchName = (
  git: GitAdapterShape,
  issueId: string,
  suffix: string | undefined,
): Effect.Effect<{ readonly branch: string; readonly attempt: number }, GitCommandError> =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= MAX_BRANCH_SEARCH_ATTEMPTS; attempt += 1) {
      const candidate = symphonyBranchName(issueId, attempt, suffix);
      const exists = yield* git.branchExists(candidate);
      if (!exists) {
        return { branch: candidate, attempt };
      }
    }
    return yield* Effect.fail(
      new GitCommandError({
        command: [
          "branch-search",
          `symphony/${issueId}${suffix === undefined ? "" : `-${suffix}`}`,
        ],
        stderr: `exhausted ${MAX_BRANCH_SEARCH_ATTEMPTS} attempt suffixes without finding a free branch name`,
        exitCode: -1,
      }),
    );
  });

export const integrateBundle = (
  git: GitAdapterShape,
  bundlePath: string,
  issueId: string,
  options: IntegrateBundleOptions = {},
): Effect.Effect<IntegrationResult, GitCommandError | BundleFetchError> =>
  Effect.gen(function* () {
    const refspec = symphonyRefspec(issueId, options.suffix);
    const refName = symphonyRefName(issueId, options.suffix);

    yield* git.fetchBundle(bundlePath, refspec);

    // Per ADR D6 the sandbox has single-commit history: the bundle's root commit *is*
    // symphony-base. "Commits beyond base" is therefore "commits in the new ref's
    // history that have at least one parent" — every non-root commit reachable from
    // the fetched ref. This formulation is independent of which branches exist on the
    // host, so it stays correct on retries that re-fetch the same bundle (the prior
    // `symphony/<id>` branch tip equals the new ref tip under the `+HEAD` refspec).
    const commitsBeyondBase = yield* git.revListCount([refName, "--min-parents=1"]);

    const { branch, attempt } = yield* findFreeBranchName(git, issueId, options.suffix);
    yield* git.branchCreate(branch, refName);

    return { branch, commitsBeyondBase, attempt };
  });
