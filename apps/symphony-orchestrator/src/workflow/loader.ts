import { FileSystem } from "@effect/platform";
import { Effect, ParseResult, Schema } from "effect";
import { parse as parseYaml } from "yaml";

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
    return yield* decodeWorkflowConfig(parsed, path);
  });
