import { Data } from "effect";

export class DaytonaConfigError extends Data.TaggedError("DaytonaConfigError")<{
  readonly missingFields: readonly string[];
  readonly details: string;
}> {
  get message(): string {
    const missing = this.missingFields.length === 0 ? "none" : this.missingFields.join(", ");
    return `Daytona config could not be decoded. Missing fields: ${missing}\n${this.details}`;
  }
}

export class DaytonaSnapshotError extends Data.TaggedError("DaytonaSnapshotError")<{
  readonly snapshotName: string;
  readonly state?: string;
  readonly reason: string;
}> {
  get message(): string {
    const state = this.state === undefined ? "" : ` state=${this.state}`;
    return `Daytona snapshot ${this.snapshotName} is not usable:${state} ${this.reason}`;
  }
}

export class DaytonaSandboxCreateError extends Data.TaggedError("DaytonaSandboxCreateError")<{
  readonly sandboxName?: string;
  readonly reason: string;
}> {
  get message(): string {
    const name = this.sandboxName === undefined ? "" : ` ${this.sandboxName}`;
    return `Daytona sandbox create failed${name}: ${this.reason}`;
  }
}

export class DaytonaSandboxOpError extends Data.TaggedError("DaytonaSandboxOpError")<{
  readonly operation: string;
  readonly sandboxId?: string;
  readonly reason: string;
}> {
  get message(): string {
    const sandbox = this.sandboxId === undefined ? "" : ` for sandbox ${this.sandboxId}`;
    return `Daytona sandbox operation ${this.operation} failed${sandbox}: ${this.reason}`;
  }
}

export class DaytonaSandboxNotFoundError extends Data.TaggedError("DaytonaSandboxNotFoundError")<{
  readonly sandboxId: string;
  readonly operation: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Daytona sandbox ${this.sandboxId} was not found during ${this.operation}: ${this.reason}`;
  }
}

export class DaytonaSessionCreateError extends Data.TaggedError("DaytonaSessionCreateError")<{
  readonly sandboxId: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Daytona session create against sandbox ${this.sandboxId} failed: ${this.reason}`;
  }
}

export class DaytonaSessionExecError extends Data.TaggedError("DaytonaSessionExecError")<{
  readonly sessionId: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Daytona session ${this.sessionId} executeSessionCommand failed: ${this.reason}`;
  }
}

export class DaytonaSessionLogError extends Data.TaggedError("DaytonaSessionLogError")<{
  readonly sessionId: string;
  readonly commandId: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Daytona session ${this.sessionId} command ${this.commandId} log stream failed: ${this.reason}`;
  }
}

export class DaytonaSessionInputError extends Data.TaggedError("DaytonaSessionInputError")<{
  readonly sessionId: string;
  readonly commandId: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Daytona session ${this.sessionId} command ${this.commandId} sendSessionCommandInput failed: ${this.reason}`;
  }
}

export class DaytonaSessionNotFoundError extends Data.TaggedError("DaytonaSessionNotFoundError")<{
  readonly sessionId: string;
  readonly operation: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Daytona session ${this.sessionId} was not found during ${this.operation}: ${this.reason}`;
  }
}

export class DaytonaSessionOpError extends Data.TaggedError("DaytonaSessionOpError")<{
  readonly sessionId: string;
  readonly operation: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Daytona session ${this.sessionId} operation ${this.operation} failed: ${this.reason}`;
  }
}
