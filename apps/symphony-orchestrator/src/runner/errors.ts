import { Data } from "effect";

export const PARSE_ERROR_LINE_TRUNCATION = 500;

export class ProtocolFramingError extends Data.TaggedError("ProtocolFramingError")<{
  readonly reason: string;
  readonly bufferedBytes?: number;
}> {
  get message(): string {
    const bytes = this.bufferedBytes === undefined ? "" : ` (buffered=${this.bufferedBytes}B)`;
    return `Runner transport framing failed${bytes}: ${this.reason}`;
  }
}

export class ProtocolParseError extends Data.TaggedError("ProtocolParseError")<{
  readonly reason: string;
  readonly line: string;
}> {
  get message(): string {
    return `Runner transport JSON parse failed on frame: ${this.reason}\n  line: ${this.line}`;
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
