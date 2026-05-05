import { Data } from "effect";

export class DaytonaConfigError extends Data.TaggedError("DaytonaConfigError")<{
  readonly missingFields: readonly string[];
  readonly details: string;
}> {
  get message(): string {
    const missing =
      this.missingFields.length === 0 ? "none" : this.missingFields.join(", ");
    return `Daytona config could not be decoded. Missing fields: ${missing}\n${this.details}`;
  }
}
