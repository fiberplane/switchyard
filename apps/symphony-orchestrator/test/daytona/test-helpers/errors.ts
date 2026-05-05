import { Data } from "effect";

export class DaytonaRunnerRepairError extends Data.TaggedError("DaytonaRunnerRepairError")<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

export class DaytonaTestSnapshotError extends Data.TaggedError("DaytonaTestSnapshotError")<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

export class DaytonaTestStackError extends Data.TaggedError("DaytonaTestStackError")<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}
