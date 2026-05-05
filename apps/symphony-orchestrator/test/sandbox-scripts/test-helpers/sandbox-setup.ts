import { NodeContext } from "@effect/platform-node";
import { Layer } from "effect";

import { DaytonaAdapterLive } from "../../../src/daytona/daytona.adapter.js";
import { SandboxScriptServiceLive } from "../../../src/sandbox-scripts/service.js";
import { daytonaTestConfig } from "../../daytona/test-helpers/stack.js";

const adapterLayer = DaytonaAdapterLive(daytonaTestConfig);

// Exposes both DaytonaAdapter and SandboxScriptService so tests can wire raw
// adapter calls (createSandbox, executeCommand probes) alongside service calls
// (setupRepo, finalizeBundle) in the same Effect.gen.
export const sandboxScriptsLayer = Layer.merge(
  Layer.provide(SandboxScriptServiceLive, adapterLayer),
  adapterLayer,
);

export const platformLayer = NodeContext.layer;
