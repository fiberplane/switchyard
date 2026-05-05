import { Data } from "effect";

export class FpBinaryNotFoundError extends Data.TaggedError("FpBinaryNotFoundError")<{
  readonly attemptedPaths: readonly string[];
}> {
  get message(): string {
    return [
      "fp binary could not be resolved",
      "Tried:",
      ...this.attemptedPaths.map((path) => `  - ${path}`),
      "Set SWITCHYARD_FP_BIN to an absolute fp binary path or install fp in one of these locations.",
    ].join("\n");
  }
}

export class FpCommandError extends Data.TaggedError("FpCommandError")<{
  readonly command: readonly string[];
  readonly stderr: string;
  readonly exitCode: number;
}> {
  get message(): string {
    return `fp command failed: ${this.command.join(" ")} (exit code ${this.exitCode})\n${this.stderr}`;
  }
}

export class FpDecodeError extends Data.TaggedError("FpDecodeError")<{
  readonly path: string;
  readonly reason: string;
  readonly details: string;
}> {
  get message(): string {
    return `fp output did not match the expected schema at ${this.path}: ${this.reason}\n${this.details}`;
  }
}

export class FpIssueNotFoundError extends Data.TaggedError("FpIssueNotFoundError")<{
  readonly issueId: string;
}> {
  get message(): string {
    return `fp issue not found: ${this.issueId}`;
  }
}
