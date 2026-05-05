import { Context, Effect, Layer } from "effect";

import { createDaytonaClient } from "./daytona-client.js";
import {
  DaytonaSessionCreateError,
  DaytonaSessionExecError,
  DaytonaSessionInputError,
  DaytonaSessionLogError,
  DaytonaSessionNotFoundError,
  DaytonaSessionOpError,
} from "./errors.js";
import type { DaytonaSandboxNotFoundError } from "./errors.js";
import type { DaytonaConfig, SandboxHandle } from "./models.js";

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

export type DaytonaSessionShape = {
  readonly start: (
    handle: SandboxHandle,
    command: string,
  ) => Effect.Effect<
    ProtocolStream,
    | DaytonaSessionCreateError
    | DaytonaSessionExecError
    | DaytonaSessionLogError
    | DaytonaSessionOpError
    | DaytonaSandboxNotFoundError
  >;
};

export class DaytonaSession extends Context.Tag("DaytonaSession")<
  DaytonaSession,
  DaytonaSessionShape
>() {}

export const DaytonaSessionLive = (config: DaytonaConfig) =>
  Layer.effect(
    DaytonaSession,
    Effect.sync(() => {
      const client = createDaytonaClient(config);
      void client;

      return {
        start: (_handle, _command) =>
          Effect.fail(
            new DaytonaSessionCreateError({
              sandboxId: "n/a",
              reason: "DaytonaSession.start not yet implemented",
            }),
          ),
      };
    }),
  );
