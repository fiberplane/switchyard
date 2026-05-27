import { Data } from "effect";

export class RemoteDaytonaCleanupError extends Data.TaggedError("RemoteDaytonaCleanupError")<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}
