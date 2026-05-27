import { Data } from "effect";

export class HostConfigError extends Data.TaggedError("HostConfigError")<{
  readonly missingFields: readonly string[];
  readonly details: string;
}> {
  get message(): string {
    const missing = this.missingFields.length === 0 ? "none" : this.missingFields.join(", ");
    return `Host runtime config could not be decoded. Missing fields: ${missing}\n${this.details}`;
  }
}
