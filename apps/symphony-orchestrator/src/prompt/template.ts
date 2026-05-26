import { Effect } from "effect";

import { WorkerPromptRenderError } from "./errors.js";

// Variable placeholder syntax: {{name}} (whitespace inside the braces tolerated). The
// substitution function walks this regex over the template at call time and fails loud on
// missing keys.
const VAR_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// The fixed worker-prompt contract. Per umbrella spec §"Worker Prompt Contract" (lines
// 768–803) and ADR D4 ("orchestrator is sole `fp` writer"). Per-workflow customization is
// intentionally NOT a feature — see `prompt/service.ts` and the ticket's Decisions for why.
//
// Variable surface (must stay in sync with `WorkerPromptVars` in `./models.ts`):
//   - issueDisplayId — e.g. "SWYRD-abc123"
//   - issueTitle     — issue title
//   - issueDescription — issue body, or a fallback string the service substitutes when the
//     underlying value is null / undefined / whitespace-only
//   - sourceInstructions — source-strategy-specific checkout and artifact notes
//   - boundaryInstructions — source-strategy-specific worker ownership limits
//   - workInstructions — source-strategy-specific work and artifact guidance
//   - outcomeInstructions — source-strategy-specific outcome envelope preface
//   - summaryInstructions — source-strategy-specific summary persistence note
export const WORKER_PROMPT_TEMPLATE = `You are a Codex worker running inside a Daytona sandbox for issue {{issueDisplayId}}: "{{issueTitle}}".

## Issue description

{{issueDescription}}

## Workspace

{{sourceInstructions}}
- The directory \`/tmp/.symphony/\` is pre-created for you by the orchestrator before your turn starts. Write your outcome envelope there (see below).

## Boundaries

{{boundaryInstructions}}

## Working in the repo

{{workInstructions}}

## Outcome envelope (REQUIRED)

{{outcomeInstructions}}

\`\`\`json
{
  "status": "completed" | "blocked" | "needs-human" | "failed",
  "summary": "<markdown narrative — what you did, why, and any caveats>"
}
\`\`\`

Pick \`status\` deliberately:

- \`"completed"\` only if you believe the work is fully done and ready for a human to review the resulting branch.
- \`"blocked"\` if a precondition you cannot satisfy stops you.
- \`"needs-human"\` if the work is partially done but you are uncertain.
- \`"failed"\` if you tried and could not produce useful output.

{{summaryInstructions}}
`;

export const renderTemplate = (
  template: string,
  vars: Readonly<Record<string, string>>,
): Effect.Effect<string, WorkerPromptRenderError> => {
  const missing = new Set<string>();

  for (const match of template.matchAll(VAR_PATTERN)) {
    const name = match[1];
    if (name === undefined) {
      // Defensive: the regex always captures group 1 when it matches. If it ever doesn't,
      // surface as a missing-variable failure rather than silently inserting "undefined".
      missing.add("<unparsed>");
      continue;
    }
    // hasOwnProperty (not truthiness): an empty string is a valid substitution value.
    // Treat a key whose value is `undefined` as missing — the caller bug should fail loud
    // rather than silently rendering an empty section.
    if (!Object.prototype.hasOwnProperty.call(vars, name) || vars[name] === undefined) {
      missing.add(name);
    }
  }

  if (missing.size > 0) {
    return Effect.fail(
      new WorkerPromptRenderError({
        missingVariables: [...missing].sort(),
      }),
    );
  }

  return Effect.succeed(
    template.replace(VAR_PATTERN, (_match, name: string) => vars[name] as string),
  );
};
