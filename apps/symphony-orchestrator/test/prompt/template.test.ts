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
    "- `/workspace/repo` mirrors the host repository root. Treat all file paths as host",
    "  repo-relative paths (for example, edit `apps/symphony-orchestrator/test/...` for",
    "  orchestrator tests, not top-level `test/...`).",
    "- The starting commit is tagged `symphony-base`. Make your changes on top of it.",
  ].join("\n"),
  boundaryInstructions: [
    "- You have **no `fp` credentials**. Do not attempt `fp` writes; the orchestrator owns all `fp` state.",
    "- You do not need to contact the host machine. Outcome flows entirely through files in the sandbox; the orchestrator collects them after your turn ends. **No host base URL is provided.**",
    "- Do **not** file follow-up issues yourself. Worker-driven follow-up filing is deferred. Put any out-of-scope observations or follow-up suggestions in your `summary` (see below) as prose.",
  ].join("\n"),
  workInstructions: [
    "- Make code changes in the repo.",
    "- Cadence: **commit early, commit often**, with descriptive commit messages — the orchestrator will preserve your full commit history via `git bundle`, and the human reviewer reads commit messages to understand your reasoning. Prefer multiple small commits over one squash.",
    "- You may run any commands you need to validate your work (build, test, type-check). The output of those commands does **not** need to be persisted; the orchestrator does not validate or re-run them.",
  ].join("\n"),
  outcomeInstructions:
    "**Before producing your final assistant message / exiting the turn**, you MUST write `/tmp/.symphony/outcome.json` with this exact shape and no extra fields:",
  summaryInstructions:
    "The `summary` becomes the fp comment narrative attached to this issue. Include any out-of-scope observations or follow-up suggestions there as prose.",
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
      "mirrors the host repository root",
      "apps/symphony-orchestrator/test/",
      "symphony-base",
      "outcome.json",
      "no `fp` credentials",
      "commit early, commit often",
      "/tmp/.symphony/",
      "No host base URL is provided",
      "do not need to contact the host machine",
      // The four valid status literals from the outcome envelope.
      '"completed"',
      '"blocked"',
      '"needs-human"',
      '"failed"',
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
