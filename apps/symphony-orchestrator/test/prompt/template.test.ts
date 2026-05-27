import { describe, expect, test } from "bun:test";

import { Effect, Either } from "effect";

import { WorkerPromptRenderError } from "../../src/prompt/errors.js";
import { MISSING_DESCRIPTION_FALLBACK } from "../../src/prompt/models.js";
import { WORKER_PROMPT_TEMPLATE, renderTemplate } from "../../src/prompt/template.js";

const runRender = (vars: Readonly<Record<string, string>>) =>
  Effect.runPromise(Effect.either(renderTemplate(WORKER_PROMPT_TEMPLATE, vars)));

const baseVars = {
  issueDisplayId: "SWYRD-abc123",
  issueTitle: "Add foo",
  issueDescription: "Implement the foo.",
  sourceInstructions: [
    "- The local repo is `/workspace/repo`. Start there.",
    "- The repo was cloned from `https://github.com/fiberplane/switchyard.git` and checked out at pinned base SHA `0123456789abcdef0123456789abcdef01234567` from `main`.",
    "- Clone metadata is available at `/tmp/.symphony/source.json` as JSON, including the deterministic worker branch `symphony/SWYRD-abc123`.",
    "- This run id is `swy-swyrd-abc123-1`; the Daytona sandbox id is `sb-123`.",
    "- Leave `origin` credential-free; GitHub access is provided through `GH_TOKEN`/`GITHUB_TOKEN` plus `GIT_ASKPASS` in the worker process environment.",
  ].join("\n"),
  boundaryInstructions: [
    "- You own durable task state after the orchestrator handoff. Use `fp` from a non-repo workdir with the REST remote, then use `gh` to open and babysit the PR.",
    "- Run fp commands from `/tmp/.symphony/fp-rest`, not from the cloned repository. The worker environment provides `FP_REMOTE=rest-api`, `FP_TOKEN`, `FP_SERVER_URL`, `FP_WORKSPACE`, and `FP_PROJECT_ID` when configured.",
    "- Do not run `gh auth login`. Use the provided `GH_TOKEN`/`GITHUB_TOKEN` environment variables. If you must isolate gh config, create a temporary `GH_CONFIG_DIR` and remove it before diagnostics.",
    "- Do not write credentials to repo files, shell profiles, fp comments, PR bodies, logs, transcripts, or diagnostics.",
  ].join("\n"),
  workInstructions: [
    "- Create or reset local branch `symphony/SWYRD-abc123` from pinned base SHA `0123456789abcdef0123456789abcdef01234567`, then make the requested changes there.",
    "- Follow the repo's fp workflow: inspect context, comment useful milestones, implement, verify, request an adversarial review, address findings, and keep commits associated with the fp issue.",
    "- Push the branch to GitHub with git using `GIT_ASKPASS`; do not put tokens in the remote URL.",
    "- Open a non-draft PR against base branch `main` with `gh pr create --base main --head symphony/SWYRD-abc123`, then babysit checks and review comments until the PR is in a reviewable state.",
    "- Set fp custom properties as soon as values are known: `symphony_branch`, `symphony_pr_url`, `symphony_pr_number`, `symphony_base_sha`, `symphony_head_sha`, `symphony_run_id`, and `symphony_sandbox_id`.",
    "- When the PR and verification are ready, mark issue `SWYRD-abc123` done with `symphony_state=end` in the same fp update that records final metadata.",
    "- Record clear verification evidence in fp comments and the PR body. Keep all credentials out of those texts.",
  ].join("\n"),
  outcomeInstructions:
    "**Before producing your final assistant message / exiting the turn**, you MUST leave the durable state in fp and GitHub: pushed branch, PR URL/number, head SHA, and the canonical `symphony_*` properties. Do not write an orchestrator return artifact.",
  outcomeBody: [
    "Required durable fields:",
    "",
    "- `symphony_branch`: `symphony/SWYRD-abc123`",
    "- `symphony_pr_url`: the GitHub PR URL",
    "- `symphony_pr_number`: the GitHub PR number as text",
    "- `symphony_base_sha`: `0123456789abcdef0123456789abcdef01234567`",
    "- `symphony_head_sha`: the pushed branch HEAD SHA",
    "- `symphony_run_id`: `swy-swyrd-abc123-1`",
    "- `symphony_sandbox_id`: `sb-123`",
    "- fp issue `SWYRD-abc123`: `status=done` and `symphony_state=end`",
    "",
  ].join("\n"),
  summaryInstructions:
    "Your final assistant message should summarize the PR URL, fp property writes, verification, and any remaining babysitting state. Do not include secrets.",
};

describe("renderTemplate / WORKER_PROMPT_TEMPLATE", () => {
  test("contains every literal contract substring from spec §Worker Prompt Contract", async () => {
    const result = await runRender(baseVars);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isLeft(result)) {
      return;
    }
    const rendered = result.right;

    // Substrings the rendered prompt MUST contain. Each one corresponds to a bullet from
    // the spec contract; if any drops out, the worker's mental model is incomplete.
    const requiredSubstrings = [
      "/workspace/repo",
      "https://github.com/fiberplane/switchyard.git",
      "0123456789abcdef0123456789abcdef01234567",
      "symphony/SWYRD-abc123",
      "swy-swyrd-abc123-1",
      "sb-123",
      "/tmp/.symphony/fp-rest",
      "FP_REMOTE=rest-api",
      "gh pr create",
      "symphony_pr_url",
      "symphony_head_sha",
      "Do not write credentials",
    ];

    for (const substring of requiredSubstrings) {
      expect(rendered).toContain(substring);
    }
  });

  test("substitutes issue identity variables into their slots", async () => {
    const result = await runRender(baseVars);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isLeft(result)) {
      return;
    }
    const rendered = result.right;

    expect(rendered).toContain("SWYRD-abc123");
    expect(rendered).toContain("Add foo");
    expect(rendered).toContain("Implement the foo.");
  });
});

describe("renderTemplate / snapshot", () => {
  // Cycle 3: literal-equality snapshot of the rendered prompt against a committed fixture.
  // The fixture is reviewable in PR diffs; if WORKER_PROMPT_TEMPLATE drifts, this test
  // fails and a human regenerates the snapshot deliberately.
  test("matches expected-prompt.txt for the with-description fixture", async () => {
    const expected = await Bun.file("test/prompt/fixtures/expected-prompt.txt").text();

    // Fixture vars match the issue-with-description.json fixture's identity fields.
    const result = await runRender({
      issueDisplayId: "SWYRD-abc123",
      issueTitle: "Add foo helper to message module",
      issueDescription:
        "Implement the foo helper. The helper should take a string and return its uppercased form. Add a test that exercises the empty-string case.",
      sourceInstructions: baseVars.sourceInstructions,
      boundaryInstructions: baseVars.boundaryInstructions,
      workInstructions: baseVars.workInstructions,
      outcomeInstructions: baseVars.outcomeInstructions,
      outcomeBody: baseVars.outcomeBody,
      summaryInstructions: baseVars.summaryInstructions,
    });

    expect(Either.isRight(result)).toBe(true);
    if (Either.isLeft(result)) {
      return;
    }
    expect(result.right).toBe(expected);
  });
});

describe("MISSING_DESCRIPTION_FALLBACK constant", () => {
  // The full null/undefined/whitespace → fallback flow is exercised in service.test.ts
  // (where `resolveDescription` is composed before substitution). Here we only assert the
  // *constant's* design properties, since template.ts has no null-handling code path.
  test("is non-empty and actionable, not '(none)'", () => {
    expect(MISSING_DESCRIPTION_FALLBACK.length).toBeGreaterThan(20);
    expect(MISSING_DESCRIPTION_FALLBACK).toContain("title");
  });

  test("contains no `{{...}}` placeholders that would be re-substituted by renderTemplate", () => {
    // Regression guard: if a future fallback string introduces `{{x}}`, renderTemplate's
    // walking substitution would attempt to resolve it and either leak a literal or fail
    // with a missing-variable error. Pin the property here.
    expect(MISSING_DESCRIPTION_FALLBACK).not.toMatch(/\{\{/);
    expect(MISSING_DESCRIPTION_FALLBACK).not.toMatch(/\}\}/);
  });
});

describe("renderTemplate / missing-variable guard", () => {
  test("fails with WorkerPromptRenderError listing every missing variable", async () => {
    const result = await runRender({ issueDisplayId: "SWYRD-abc123" });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) {
      return;
    }
    const error = result.left;
    expect(error).toBeInstanceOf(WorkerPromptRenderError);
    if (!(error instanceof WorkerPromptRenderError)) {
      return;
    }

    expect(error.missingVariables).toContain("issueTitle");
    expect(error.missingVariables).toContain("issueDescription");
    expect(error.missingVariables).toContain("sourceInstructions");
    expect(error.missingVariables).toContain("boundaryInstructions");
    expect(error.missingVariables).toContain("workInstructions");
    expect(error.missingVariables).toContain("outcomeInstructions");
    expect(error.missingVariables).toContain("summaryInstructions");
    // Should NOT list a key that was provided.
    expect(error.missingVariables).not.toContain("issueDisplayId");
  });

  test("treats explicit `undefined` value as missing (caller bug fails loud)", async () => {
    const result = await runRender({
      ...baseVars,
      issueDescription: undefined as unknown as string,
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) {
      return;
    }
    const error = result.left;
    expect(error).toBeInstanceOf(WorkerPromptRenderError);
    if (!(error instanceof WorkerPromptRenderError)) {
      return;
    }
    expect(error.missingVariables).toContain("issueDescription");
  });

  test("empty-string value is a valid substitution, not 'missing'", async () => {
    // Closed-shape vars with a deliberately-empty value. The template still has
    // `{{issueDescription}}` so the render produces a section with an empty body — but
    // the render itself succeeds because the key is present.
    const result = await runRender({ ...baseVars, issueDescription: "" });

    expect(Either.isRight(result)).toBe(true);
  });

  test("succeeds with a fully-populated vars object", async () => {
    const result = await runRender(baseVars);

    expect(Either.isRight(result)).toBe(true);
  });
});
