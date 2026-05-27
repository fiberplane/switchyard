import { Context, Effect, Layer } from "effect";

import { DaytonaAdapter } from "../daytona/daytona.adapter.js";
import type { DaytonaSandboxNotFoundError, DaytonaSandboxOpError } from "../daytona/errors.js";
import type { SandboxHandle } from "../daytona/models.js";
import type { SandboxScriptError } from "./errors.js";
import type { SetupCloneOptions } from "./models.js";
import { runSetupClone } from "./setup.js";

export type SandboxScriptServiceShape = {
  readonly setupClone: (
    handle: SandboxHandle,
    options: SetupCloneOptions,
  ) => Effect.Effect<
    void,
    SandboxScriptError | DaytonaSandboxNotFoundError | DaytonaSandboxOpError
  >;
};

export class SandboxScriptService extends Context.Tag("SandboxScriptService")<
  SandboxScriptService,
  SandboxScriptServiceShape
>() {}

export const SandboxScriptServiceLive = Layer.effect(
  SandboxScriptService,
  Effect.gen(function* () {
    const adapter = yield* DaytonaAdapter;
    return {
      setupClone: (handle, options) => runSetupClone(adapter, handle, options),
    };
  }),
);
