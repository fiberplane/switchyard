// Layer-wiring helper: builds a complete OrchestratorService Layer from the
// individual mock shapes, plus a NodeFileSystem layer. Tests stay short by
// calling `wireOrchestrator(mocks).pipe(Effect.runPromise)`.

import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { ArtifactStore } from "../../../src/artifact/store.js";
import { DaytonaAdapter } from "../../../src/daytona/daytona.adapter.js";
import { DaytonaSession } from "../../../src/daytona/daytona.session.js";
import { FpService } from "../../../src/fp/service.js";
import { IntegrationService } from "../../../src/integration/service.js";
import {
  OrchestratorServiceLive,
  type OrchestratorServiceConfig,
} from "../../../src/orchestrator/service.js";
import { WorkerPromptService } from "../../../src/prompt/service.js";
import { AgentRunner, AgentRunnerLive } from "../../../src/runner/service.js";
import {
  SandboxScriptService,
  type SandboxScriptServiceShape,
} from "../../../src/sandbox-scripts/service.js";
import {
  makeArtifactStoreMock,
  makeDaytonaAdapterMock,
  makeFpMock,
  makeIntegrationMock,
  makePromptMock,
  makeSandboxScriptMock,
  type DaytonaSessionMock,
  type FpMock,
  type IntegrationMock,
  type ArtifactStoreMock,
  type DaytonaAdapterMock,
} from "./mocks.js";

export type WireOptions = {
  readonly fp: FpMock;
  readonly daytona: DaytonaAdapterMock;
  readonly session: DaytonaSessionMock;
  readonly integration: IntegrationMock;
  readonly artifact: ArtifactStoreMock;
  readonly config: OrchestratorServiceConfig;
  // Use the real AgentRunner (drives the protocol) by default, or override
  // when a stub is desired (failure-path cycles).
  readonly agentRunner?: Layer.Layer<AgentRunner>;
  // Override the SandboxScriptService mock when a cycle needs to drive the
  // empty-bundle (commitsBeyondBase=0) or finalize-failure path.
  readonly sandboxScripts?: SandboxScriptServiceShape;
};

export const writeFakeCodexAuth = (): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs
      .makeTempDirectory({ prefix: "swy-codex-auth-", directory: tmpdir() })
      .pipe(Effect.orDie);
    const path = join(dir, "auth.json");
    yield* fs
      .writeFileString(path, JSON.stringify({ access_token: "fixture", refresh_token: "fixture" }))
      .pipe(Effect.orDie);
    return path;
  });

export const wire = (options: WireOptions) => {
  const layer = Layer.mergeAll(
    Layer.succeed(FpService, options.fp.shape),
    Layer.succeed(DaytonaAdapter, options.daytona.shape),
    Layer.succeed(DaytonaSession, options.session.shape),
    Layer.succeed(IntegrationService, options.integration.shape),
    Layer.succeed(ArtifactStore, options.artifact.shape),
    Layer.succeed(WorkerPromptService, makePromptMock()),
    Layer.succeed(SandboxScriptService, options.sandboxScripts ?? makeSandboxScriptMock()),
    options.agentRunner ?? AgentRunnerLive,
  );
  const fullLayer = OrchestratorServiceLive(options.config).pipe(Layer.provide(layer));
  return Layer.merge(fullLayer, NodeFileSystem.layer);
};

export { makeArtifactStoreMock, makeDaytonaAdapterMock, makeFpMock, makeIntegrationMock };
