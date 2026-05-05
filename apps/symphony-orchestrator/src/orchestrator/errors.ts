import { Data } from "effect";

export class AlreadyClaimedError extends Data.TaggedError("AlreadyClaimedError")<{
  readonly issueId: string;
}> {
  get message(): string {
    return `Issue ${this.issueId} is already claimed by the orchestrator`;
  }
}
