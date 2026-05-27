import { Data } from "effect";

// Hard cap so a runaway worker summary or stack trace can never explode
// the symphony_last_error property. Locked rule from §7: first non-empty
// line, ≤200 chars, ellipsis suffix on truncation.
export const SYMPHONY_LAST_ERROR_MAX_CHARS = 200;
const ELLIPSIS = "…";

// Apply to: worker `summary`, runner error reasons, sandbox/script error
// stderr, integration error reasons. Reused at every `markNeedsAttention`
// call site so the property write shape stays uniform.
export const truncateLastError = (raw: string): string => {
  const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "";
  if (firstLine.length <= SYMPHONY_LAST_ERROR_MAX_CHARS) {
    return firstLine;
  }
  return `${firstLine.slice(0, SYMPHONY_LAST_ERROR_MAX_CHARS - ELLIPSIS.length)}${ELLIPSIS}`;
};

export class AlreadyClaimedError extends Data.TaggedError("AlreadyClaimedError")<{
  readonly issueId: string;
}> {
  get message(): string {
    return `Issue ${this.issueId} is already claimed by the orchestrator`;
  }
}

// Pre-claim host-side codex auth read failed: ~/.codex/auth.json is missing or
// unreadable. The pipeline aborts before claiming so the issue never enters the
// running set; the failure is logged at the orchestrator level (operator alert).
export class MissingCodexAuthError extends Data.TaggedError("MissingCodexAuthError")<{
  readonly path: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Codex auth file not found or unreadable at ${this.path}: ${this.reason}`;
  }
}

// Wraps writeTranscript's underlying FS errors so service.ts can catch a single
// orchestrator-owned tag rather than a PlatformError union.
export class TranscriptWriteError extends Data.TaggedError("TranscriptWriteError")<{
  readonly path: string;
  readonly operation: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Transcript ${this.operation} failed at ${this.path}: ${this.reason}`;
  }
}

// Pre-claim selector/dispatch failure: candidate fetch or GitHub clone handoff
// or renderPrompt failed before the running-set claim. Drives "log + skip" at
// the tick level; never writes fp (state.ts wasn't entered yet).
export class DispatchError extends Data.TaggedError("DispatchError")<{
  readonly stage: "fetch-candidates" | "prepare-source" | "render-prompt" | "read-codex-auth";
  readonly issueId?: string;
  readonly reason: string;
}> {
  get message(): string {
    const where = this.issueId === undefined ? this.stage : `${this.stage}/${this.issueId}`;
    return `Pre-claim dispatch failed at ${where}: ${this.reason}`;
  }
}

// Catch-all for runner protocol failures (timeouts, framing, send, recv,
// session closed, turn cancelled / failed / input-required). The runOne
// pipeline catches every RunnerError tag and re-tags as ProtocolStreamError so
// the F7 / F7b row produces a uniform `symphony_last_error="protocol stream
// <reason>"`.
export class ProtocolStreamError extends Data.TaggedError("ProtocolStreamError")<{
  readonly issueId: string;
  readonly attempt: number;
  readonly kind: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Protocol stream ${this.kind} for ${this.issueId} (attempt ${this.attempt}): ${this.reason}`;
  }
}

// In-sandbox setup/session/upload failure. Surfaces stage so runOne can map
// setup errors separately from codex app-server start errors.
export class SandboxSetupError extends Data.TaggedError("SandboxSetupError")<{
  readonly issueId: string;
  readonly attempt: number;
  readonly stage:
    | "setup"
    | "create"
    | "upload"
    | "session-start"
    | "render-prompt"
    | "render-worker-env";
  readonly reason: string;
}> {
  get message(): string {
    return `Sandbox ${this.stage} failed for ${this.issueId} (attempt ${this.attempt}): ${this.reason}`;
  }
}

// `symphony_attempt` value present on the issue did not parse to a positive
// integer. Locked rule: do NOT default-coerce to 0; park needs-attention with
// `symphony_last_error="unparseable symphony_attempt: <raw>"`.
export class UnparseableAttemptError extends Data.TaggedError("UnparseableAttemptError")<{
  readonly issueId: string;
  readonly raw: string;
}> {
  get message(): string {
    return `Issue ${this.issueId} has unparseable symphony_attempt: ${this.raw}`;
  }
}

// fp write (claim / setAttempt / addComment / markCompleted /
// markNeedsAttention / setRunMetadata) failed underlyingly (binary missing,
// command failed). §7b F15: retry once, then log + leave issue in
// `in-progress`. v1 surfaces the wrapped error so the integration test can
// assert on a single tag.
export class FpWriteFailedError extends Data.TaggedError("FpWriteFailedError")<{
  readonly issueId: string;
  readonly operation: string;
  readonly reason: string;
}> {
  get message(): string {
    return `fp write ${this.operation} failed for ${this.issueId}: ${this.reason}`;
  }
}

// Wrapping the platform-level FS errors that pop up around tempdir cleanup or
// codex auth probing. Pre-claim path uses MissingCodexAuthError; this is the
// catch-all for in-pipeline FS surprises.
export class HostFileSystemError extends Data.TaggedError("HostFileSystemError")<{
  readonly path: string;
  readonly operation: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Host FS ${this.operation} failed at ${this.path}: ${this.reason}`;
  }
}

// Discriminated union exposed to callers (index.ts, integration tests). Every
// post-claim failure path inside `runOne` resolves into one of these tags
// before bubbling out — pre-claim failures (DispatchError) never reach the
// outer scope because the tick handler logs + skips them inline.
export type OrchestratorError =
  | AlreadyClaimedError
  | DispatchError
  | FpWriteFailedError
  | HostFileSystemError
  | MissingCodexAuthError
  | ProtocolStreamError
  | SandboxSetupError
  | TranscriptWriteError
  | UnparseableAttemptError;
