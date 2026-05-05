import { Data } from "effect";

// Host-side test-helper failure. Distinct from `SandboxScriptError` so a future
// reader greppping for "did this error come from inside a sandbox?" never gets
// a false positive from the test seed path.
export class SeedArchiveError extends Data.TaggedError("SeedArchiveError")<{
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  get message(): string {
    return `seedArchive: ${this.command} (exit ${this.exitCode}): ${this.stderr}`;
  }
}
