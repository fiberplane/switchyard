import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";

import type { WorkflowDecodeError, WorkflowFileMissing } from "./errors.js";
import { loadWorkflowConfig } from "./loader.js";
import type { WorkflowConfig } from "./models.js";

export type WorkflowServiceShape = {
  readonly load: (
    path: string,
  ) => Effect.Effect<
    WorkflowConfig,
    WorkflowFileMissing | WorkflowDecodeError,
    FileSystem.FileSystem
  >;
};

export class WorkflowService extends Context.Tag("WorkflowService")<
  WorkflowService,
  WorkflowServiceShape
>() {
  static readonly load = loadWorkflowConfig;
}

export const WorkflowServiceLive = Layer.succeed(WorkflowService, {
  load: loadWorkflowConfig,
});
