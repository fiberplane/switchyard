import { Data } from "effect";

export class WorkerPromptRenderError extends Data.TaggedError("WorkerPromptRenderError")<{
  readonly missingVariables: ReadonlyArray<string>;
}> {
  get message(): string {
    return `worker prompt render failed: missing variables [${this.missingVariables.join(", ")}]`;
  }
}

export class WorkerPromptWriteError extends Data.TaggedError("WorkerPromptWriteError")<{
  readonly path: string;
  readonly reason: string;
}> {
  get message(): string {
    return `worker prompt write failed at ${this.path}: ${this.reason}`;
  }
}

export type WorkerPromptError = WorkerPromptRenderError | WorkerPromptWriteError;
