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
