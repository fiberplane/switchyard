import type { Daytona, Sandbox } from "@daytona/sdk";
import { Context, Effect, Layer, ParseResult, Schema, type Scope } from "effect";

import { createDaytonaClient, describeUnknown, isDaytonaNotFound } from "./daytona-client.js";
import {
  DaytonaSandboxNotFoundError,
  DaytonaSessionCreateError,
  DaytonaSessionExecError,
  DaytonaSessionInputError,
  DaytonaSessionLogError,
  DaytonaSessionNotFoundError,
  DaytonaSessionOpError,
} from "./errors.js";
import type { DaytonaConfig, SandboxHandle } from "./models.js";
import { DaytonaSessionExecuteResponseSchema } from "./session-models.js";

export type DaytonaSessionExitInfo = {
  readonly exitCode: number;
};

export type ProtocolStream = {
  readonly sessionId: string;
  readonly commandId: string;
  readonly send: (
    data: string,
  ) => Effect.Effect<void, DaytonaSessionInputError | DaytonaSessionNotFoundError>;
};

export type DaytonaSessionStartError =
  | DaytonaSandboxNotFoundError
  | DaytonaSessionCreateError
  | DaytonaSessionExecError
  | DaytonaSessionLogError
  | DaytonaSessionNotFoundError
  | DaytonaSessionOpError;

export type DaytonaSessionShape = {
  readonly start: (
    handle: SandboxHandle,
    command: string,
  ) => Effect.Effect<ProtocolStream, DaytonaSessionStartError, Scope.Scope>;
};

export class DaytonaSession extends Context.Tag("DaytonaSession")<
  DaytonaSession,
  DaytonaSessionShape
>() {}

const generateSessionId = (): string => `swyrd-${crypto.randomUUID()}`;

const getSandboxForSession = (
  client: Daytona,
  sandboxId: string,
): Effect.Effect<Sandbox, DaytonaSandboxNotFoundError | DaytonaSessionOpError> =>
  Effect.tryPromise({
    try: () => client.get(sandboxId),
    catch: (error) => {
      if (isDaytonaNotFound(error)) {
        return new DaytonaSandboxNotFoundError({
          sandboxId,
          operation: "createSession",
          reason: describeUnknown(error),
        });
      }

      return new DaytonaSessionOpError({
        sessionId: "n/a",
        operation: "getSandbox",
        reason: describeUnknown(error),
      });
    },
  });

const createSession = (
  sandbox: Sandbox,
  sandboxId: string,
  sessionId: string,
): Effect.Effect<void, DaytonaSessionCreateError | DaytonaSandboxNotFoundError> =>
  Effect.tryPromise({
    try: () => sandbox.process.createSession(sessionId),
    catch: (error) => {
      if (isDaytonaNotFound(error)) {
        return new DaytonaSandboxNotFoundError({
          sandboxId,
          operation: "createSession",
          reason: describeUnknown(error),
        });
      }

      return new DaytonaSessionCreateError({
        sandboxId,
        reason: describeUnknown(error),
      });
    },
  }).pipe(Effect.asVoid);

const releaseSession = (sandbox: Sandbox, sessionId: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => sandbox.process.deleteSession(sessionId),
    catch: (error) => error,
  }).pipe(Effect.ignore);

const executeSessionCommand = (
  sandbox: Sandbox,
  sessionId: string,
  command: string,
): Effect.Effect<string, DaytonaSessionExecError | DaytonaSessionNotFoundError> =>
  Effect.tryPromise({
    try: () => sandbox.process.executeSessionCommand(sessionId, { command, runAsync: true }),
    catch: (error) => {
      if (isDaytonaNotFound(error)) {
        return new DaytonaSessionNotFoundError({
          sessionId,
          operation: "executeSessionCommand",
          reason: describeUnknown(error),
        });
      }

      return new DaytonaSessionExecError({
        sessionId,
        reason: describeUnknown(error),
      });
    },
  }).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknown(DaytonaSessionExecuteResponseSchema)(response).pipe(
        Effect.catchTag("ParseError", (parseError) =>
          Effect.fail(
            new DaytonaSessionExecError({
              sessionId,
              reason: `executeSessionCommand response decode failed: ${ParseResult.TreeFormatter.formatErrorSync(parseError)}`,
            }),
          ),
        ),
      ),
    ),
    Effect.map(({ cmdId }) => cmdId),
  );

const start = (
  client: Daytona,
  handle: SandboxHandle,
  command: string,
): Effect.Effect<ProtocolStream, DaytonaSessionStartError, Scope.Scope> =>
  Effect.gen(function* () {
    const sandbox = yield* getSandboxForSession(client, handle.id);
    const sessionId = generateSessionId();

    yield* Effect.acquireRelease(createSession(sandbox, handle.id, sessionId), () =>
      releaseSession(sandbox, sessionId),
    );

    const commandId = yield* executeSessionCommand(sandbox, sessionId, command);

    const stream: ProtocolStream = {
      sessionId,
      commandId,
      send: () =>
        Effect.fail(
          new DaytonaSessionInputError({
            sessionId,
            commandId,
            reason: "DaytonaSession.send not yet implemented",
          }),
        ),
    };

    return stream;
  }).pipe(Effect.withSpan("DaytonaSession.start"));

export const DaytonaSessionLive = (config: DaytonaConfig) =>
  Layer.effect(
    DaytonaSession,
    Effect.sync(() => {
      const client = createDaytonaClient(config);

      return {
        start: (handle, command) => start(client, handle, command),
      };
    }),
  );
