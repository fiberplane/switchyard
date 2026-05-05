import { Data } from "effect";

export const PARSE_ERROR_LINE_TRUNCATION = 500;

export class ProtocolFramingError extends Data.TaggedError("ProtocolFramingError")<{
  readonly reason: string;
  readonly bufferedChars?: number;
}> {
  get message(): string {
    const buffered =
      this.bufferedChars === undefined ? "" : ` (bufferedChars=${this.bufferedChars})`;
    return `Runner transport framing failed${buffered}: ${this.reason}`;
  }
}

export class ProtocolParseError extends Data.TaggedError("ProtocolParseError")<{
  readonly reason: string;
  readonly line: string;
}> {
  get message(): string {
    return `Runner transport JSON parse failed on frame: ${this.reason} | line=${this.line}`;
  }
}

export class ProtocolSendError extends Data.TaggedError("ProtocolSendError")<{
  readonly reason: string;
}> {
  get message(): string {
    return `Runner transport send failed: ${this.reason}`;
  }
}

export class ProtocolRecvError extends Data.TaggedError("ProtocolRecvError")<{
  readonly reason: string;
}> {
  get message(): string {
    return `Runner transport receive stream failed: ${this.reason}`;
  }
}

export class RunnerRequestTimeoutError extends Data.TaggedError("RunnerRequestTimeoutError")<{
  readonly method: string;
  readonly requestId: number;
  readonly timeoutMs: number;
}> {
  get message(): string {
    return `Runner request ${this.method}#${this.requestId} timed out after ${this.timeoutMs}ms`;
  }
}

export class RunnerRequestError extends Data.TaggedError("RunnerRequestError")<{
  readonly method: string;
  readonly requestId: number;
  readonly reason: string;
}> {
  get message(): string {
    return `Runner request ${this.method}#${this.requestId} failed: ${this.reason}`;
  }
}

export class RunnerProtocolError extends Data.TaggedError("RunnerProtocolError")<{
  readonly reason: string;
}> {
  get message(): string {
    return `Runner protocol error: ${this.reason}`;
  }
}

export class RunnerSessionClosedError extends Data.TaggedError("RunnerSessionClosedError")<{
  readonly reason: string;
}> {
  get message(): string {
    return `Runner session closed: ${this.reason}`;
  }
}

export class RunnerTurnTimeoutError extends Data.TaggedError("RunnerTurnTimeoutError")<{
  readonly threadId: string;
  readonly timeoutMs: number;
}> {
  get message(): string {
    return `Runner turn on thread ${this.threadId} timed out after ${this.timeoutMs}ms`;
  }
}

export class RunnerTurnFailedError extends Data.TaggedError("RunnerTurnFailedError")<{
  readonly reason: string;
}> {
  get message(): string {
    return `Runner turn failed: ${this.reason}`;
  }
}

export class RunnerTurnCancelledError extends Data.TaggedError("RunnerTurnCancelledError")<{
  readonly reason: string;
}> {
  get message(): string {
    return `Runner turn was cancelled: ${this.reason}`;
  }
}

export class RunnerTurnInputRequiredError extends Data.TaggedError("RunnerTurnInputRequiredError")<{
  readonly prompt: unknown;
}> {
  get message(): string {
    return `Runner turn requested user input: ${JSON.stringify(this.prompt)}`;
  }
}

export class LocalCodexUnavailableError extends Data.TaggedError("LocalCodexUnavailableError")<{
  readonly reason: string;
}> {
  get message(): string {
    return `Local codex unavailable: ${this.reason}`;
  }
}
