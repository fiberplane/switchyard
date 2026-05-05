import { Context, Effect, Layer } from "effect";

import { DaytonaAdapter } from "../daytona/daytona.adapter.js";
import type { DaytonaSandboxNotFoundError, DaytonaSandboxOpError } from "../daytona/errors.js";
import type { SandboxHandle } from "../daytona/models.js";
import type { SandboxScriptError } from "./errors.js";
import { runFinalize } from "./finalize.js";
import type { FinalizeBundleOptions, SandboxBundleResult, SetupRepoOptions } from "./models.js";
import { runSetup } from "./setup.js";

export type SandboxScriptServiceShape = {
  readonly setupRepo: (
    handle: SandboxHandle,
    options: SetupRepoOptions,
  ) => Effect.Effect<
    void,
    SandboxScriptError | DaytonaSandboxNotFoundError | DaytonaSandboxOpError
  >;
  readonly finalizeBundle: (
    handle: SandboxHandle,
    options: FinalizeBundleOptions,
  ) => Effect.Effect<
    SandboxBundleResult,
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
      setupRepo: (handle, options) => runSetup(adapter, handle, options),
      finalizeBundle: (handle, options) => runFinalize(adapter, handle, options),
    };
  }),
);
