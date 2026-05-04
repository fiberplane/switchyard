import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Either } from "effect";

import { WorkflowDecodeError, WorkflowFileMissing } from "../../src/workflow/errors.js";
import { WorkflowService } from "../../src/workflow/service.js";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const originalCwd = process.cwd();

beforeAll(() => {
  process.chdir(appRoot);
});

afterAll(() => {
  process.chdir(originalCwd);
});

const runWithFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));

describe("WorkflowService.load", () => {
  test("loads and decodes the spec workflow YAML", async () => {
    const config = await runWithFileSystem(
      WorkflowService.load("test/fixtures/workflow.valid.yml"),
    );

    expect(config.tracker.kind).toBe("fp");
    expect(config.codex.command).toBe("codex app-server");
    expect(config.agent.maxAttempts).toBe(1);
    expect(config.sandbox.apiUrl).toBe("$DAYTONA_API_URL");
    expect(config.codex.approvalPolicy).toBe("never");
    expect(config.codex.sandbox).toBe("danger-full-access");
    expect(config.codex.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });

  test("maps missing required config fields to WorkflowDecodeError", async () => {
    const result = await runWithFileSystem(
      Effect.either(WorkflowService.load("test/fixtures/workflow.invalid-missing-tracker.yml")),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const error = result.left;
      expect(error).toBeInstanceOf(WorkflowDecodeError);
      if (error instanceof WorkflowDecodeError) {
        expect(error.path).toBe("test/fixtures/workflow.invalid-missing-tracker.yml");
        expect(error.details).toContain('["tracker"]');
      }
    }
  });

  test("rejects codex approval and sandbox policies that would stall app-server", async () => {
    const result = await runWithFileSystem(
      Effect.either(WorkflowService.load("test/fixtures/workflow.invalid-bad-policy.yml")),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const error = result.left;
      expect(error).toBeInstanceOf(WorkflowDecodeError);
      if (error instanceof WorkflowDecodeError) {
        expect(error.details).toContain("approvalPolicy");
        expect(error.details).toContain("sandbox");
      }
    }
  });

  test("maps unreadable files to WorkflowFileMissing", async () => {
    const result = await runWithFileSystem(
      Effect.either(WorkflowService.load("test/fixtures/missing.yml")),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(WorkflowFileMissing);
      expect(result.left.path).toBe("test/fixtures/missing.yml");
    }
  });
});
