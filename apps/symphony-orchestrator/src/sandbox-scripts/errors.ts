import { Data } from "effect";

import type { SandboxScriptOperation } from "./models.js";

export class SandboxScriptError extends Data.TaggedError("SandboxScriptError")<{
  readonly operation: SandboxScriptOperation;
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  get message(): string {
    return `sandbox-script ${this.operation} failed (exit ${this.exitCode}): ${this.stderr}`;
  }
}
