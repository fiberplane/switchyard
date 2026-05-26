import { Data } from "effect";

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly command: readonly string[];
  readonly stderr: string;
  readonly exitCode: number;
}> {
  get message(): string {
    return `git command failed: ${this.command.join(" ")} (exit code ${this.exitCode})\n${this.stderr}`;
  }
}

export class BundleFetchError extends Data.TaggedError("BundleFetchError")<{
  readonly bundlePath: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {
  get message(): string {
    return `git failed to fetch from bundle ${this.bundlePath} (exit code ${this.exitCode})\n${this.stderr}`;
  }
}

export class SourceValidationError extends Data.TaggedError("SourceValidationError")<{
  readonly field: string;
  readonly reason: string;
}> {
  get message(): string {
    return `invalid source ${this.field}: ${this.reason}`;
  }
}
