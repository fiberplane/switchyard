import { Data } from "effect";

export class ProtocolFramingError extends Data.TaggedError("ProtocolFramingError")<{
  readonly reason: string;
  readonly bufferedBytes?: number;
}> {
  get message(): string {
    const bytes = this.bufferedBytes === undefined ? "" : ` (buffered=${this.bufferedBytes}B)`;
    return `Runner transport framing failed${bytes}: ${this.reason}`;
  }
}
