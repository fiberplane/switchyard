import { Data } from "effect";

export class WorkflowFileMissing extends Data.TaggedError("WorkflowFileMissing")<{
  readonly path: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Workflow config file could not be read at ${this.path}: ${this.reason}`;
  }
}

export class WorkflowDecodeError extends Data.TaggedError("WorkflowDecodeError")<{
  readonly path: string;
  readonly reason: string;
  readonly details: string;
}> {
  get message(): string {
    return `Workflow config did not match the expected schema at ${this.path}: ${this.reason}\n${this.details}`;
  }
}
