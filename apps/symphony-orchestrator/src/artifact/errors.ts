import { Data } from "effect";

export class ArtifactPathError extends Data.TaggedError("ArtifactPathError")<{
  readonly path: string;
  readonly operation: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Artifact ${this.operation} failed at ${this.path}: ${this.reason}`;
  }
}

export class ArtifactDecodeError extends Data.TaggedError("ArtifactDecodeError")<{
  readonly path: string;
  readonly reason: string;
  readonly details: string;
}> {
  get message(): string {
    return `Artifact did not match the expected schema at ${this.path}: ${this.reason}\n${this.details}`;
  }
}
