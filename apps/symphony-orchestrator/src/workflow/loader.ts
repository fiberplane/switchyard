import { FileSystem } from "@effect/platform";
import { Effect, ParseResult, Schema } from "effect";
import { parse as parseYaml } from "yaml";

import { validateGitBranchName, validateGitHubRepoUrl } from "../integration/source.js";
import { WorkflowDecodeError, WorkflowFileMissing } from "./errors.js";
import { WorkflowConfig } from "./models.js";

const describeUnknown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const parseWorkflowYaml = (
  content: string,
  path: string,
): Effect.Effect<unknown, WorkflowDecodeError> =>
  Effect.try({
    try: (): unknown => parseYaml(content),
    catch: (error) =>
      new WorkflowDecodeError({
        path,
        reason: "YAML parsing failed",
        details: describeUnknown(error),
      }),
  });

const decodeWorkflowConfig = (
  value: unknown,
  path: string,
): Effect.Effect<WorkflowConfig, WorkflowDecodeError> =>
  Schema.decodeUnknown(WorkflowConfig)(value).pipe(
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new WorkflowDecodeError({
          path,
          reason: "schema validation failed",
          details: ParseResult.TreeFormatter.formatErrorSync(error),
        }),
      ),
    ),
  );

const forbiddenSecretFieldNames = new Set([
  "apikey",
  "githubtoken",
  "fptoken",
  "pat",
  "password",
  "secret",
  "token",
]);

const isForbiddenSecretField = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[_-]/gu, "");
  return (
    forbiddenSecretFieldNames.has(normalized) ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.endsWith("pat")
  );
};

const findForbiddenSecretPath = (
  value: unknown,
  path: ReadonlyArray<string> = [],
): string | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findForbiddenSecretPath(entry, [...path, String(index)]);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  for (const [key, entry] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (isForbiddenSecretField(key)) {
      return nextPath.join(".");
    }
    const found = findForbiddenSecretPath(entry, nextPath);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
};

const rejectForbiddenSecrets = (
  value: unknown,
  path: string,
): Effect.Effect<void, WorkflowDecodeError> =>
  Effect.gen(function* () {
    const fieldPath = findForbiddenSecretPath(value);
    if (fieldPath === undefined) {
      return;
    }

    return yield* Effect.fail(
      new WorkflowDecodeError({
        path,
        reason: "forbidden secret-bearing workflow field",
        details: `Remove ${fieldPath} from the workflow file. Use host env instead.`,
      }),
    );
  });

const rejectInvalidGithubCloneSource = (
  value: unknown,
  path: string,
): Effect.Effect<void, WorkflowDecodeError> => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sandbox" in value) ||
    typeof value.sandbox !== "object" ||
    value.sandbox === null ||
    !("sourceStrategy" in value.sandbox) ||
    value.sandbox.sourceStrategy !== "githubClone"
  ) {
    return Effect.void;
  }

  try {
    validateGitHubRepoUrl(String((value.sandbox as Record<string, unknown>).repoUrl ?? ""));
    validateGitBranchName(String((value.sandbox as Record<string, unknown>).baseBranch ?? ""));
    return Effect.void;
  } catch (error) {
    return Effect.fail(
      new WorkflowDecodeError({
        path,
        reason: "invalid github clone source",
        details: error instanceof Error ? error.message : String(error),
      }),
    );
  }
};

export const loadWorkflowConfig = (
  path: string,
): Effect.Effect<
  WorkflowConfig,
  WorkflowFileMissing | WorkflowDecodeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (error) =>
          new WorkflowFileMissing({
            path,
            reason: describeUnknown(error),
          }),
      ),
    );
    const parsed = yield* parseWorkflowYaml(content, path);
    yield* rejectForbiddenSecrets(parsed, path);
    yield* rejectInvalidGithubCloneSource(parsed, path);
    return yield* decodeWorkflowConfig(parsed, path);
  });
