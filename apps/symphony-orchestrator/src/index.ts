import { homedir } from "node:os";
import path from "node:path";

import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Context, Deferred, Duration, Effect, Layer, Schedule } from "effect";

import { ArtifactStoreLive } from "./artifact/store.js";
import { DaytonaAdapter, DaytonaAdapterLive } from "./daytona/daytona.adapter.js";
import { DaytonaSession, DaytonaSessionLive } from "./daytona/daytona.session.js";
import type { DaytonaConfig } from "./daytona/models.js";
import { FpAdapterLive } from "./fp/adapter.js";
import { FpBinaryLive } from "./fp/binary.js";
import { FpServiceLive } from "./fp/service.js";
import { GitAdapterLive } from "./integration/git.adapter.js";
import { IntegrationServiceLive } from "./integration/service.js";
import { structuredLoggerLayer } from "./observability/logger.js";
import {
  OrchestratorService,
  OrchestratorServiceLive,
  type OrchestratorServiceConfig,
} from "./orchestrator/service.js";
import { WorkerPromptServiceLive } from "./prompt/service.js";
import { AgentRunnerLive } from "./runner/service.js";
import { SandboxScriptServiceLive } from "./sandbox-scripts/service.js";
import { loadWorkflowConfig } from "./workflow/loader.js";
import type { SandboxConfig, WorkflowConfig } from "./workflow/models.js";
import { WorkflowServiceLive } from "./workflow/service.js";

type OrchestratorServiceShape = Context.Tag.Service<OrchestratorService>;

export type CliOptions = {
  readonly workflow: string;
};

export const parseCliOptions = (
  argv: ReadonlyArray<string> = process.argv.slice(2),
): CliOptions => {
  const workflowFlagIndex = argv.indexOf("--workflow");
  if (workflowFlagIndex === -1) {
    return { workflow: "./WORKFLOW.md" };
  }
  const workflow = argv[workflowFlagIndex + 1];
  return { workflow: workflow === undefined || workflow.length === 0 ? "./WORKFLOW.md" : workflow };
};

export const toDaytonaConfig = (cfg: SandboxConfig): DaytonaConfig => ({
  apiUrl: cfg.apiUrl,
  apiKey: cfg.apiKey,
  target: cfg.target,
  snapshotName: cfg.snapshot,
});

export const toOrchestratorConfig = (
  cfg: WorkflowConfig,
  env: Record<string, string | undefined> = process.env,
): OrchestratorServiceConfig => ({
  maxConcurrentAgents: cfg.agent.maxConcurrentAgents,
  turnTimeoutMs: cfg.codex.turnTimeoutMs,
  snapshotName: cfg.sandbox.snapshot,
  autoStopInterval: cfg.sandbox.autoStopInterval,
  autoDeleteInterval: cfg.sandbox.autoDeleteInterval,
  codexAuthHostPath: env.SWITCHYARD_CODEX_AUTH ?? path.join(homedir(), ".codex/auth.json"),
});

export const buildDaytonaLayers = (
  cfg: DaytonaConfig,
  options: { readonly probeOnInit?: boolean } = { probeOnInit: true },
): Layer.Layer<DaytonaAdapter | DaytonaSession, unknown> =>
  Layer.merge(DaytonaAdapterLive(cfg, options), DaytonaSessionLive(cfg));

export const buildPlatformLayer = (cfg: WorkflowConfig) => {
  const daytonaLayers = buildDaytonaLayers(toDaytonaConfig(cfg.sandbox));
  const fpStack = FpServiceLive.pipe(Layer.provide(FpAdapterLive()), Layer.provide(FpBinaryLive()));
  const integrationStack = IntegrationServiceLive.pipe(Layer.provide(GitAdapterLive()));
  const sandboxScripts = SandboxScriptServiceLive.pipe(Layer.provide(daytonaLayers));
  const orchestrator = OrchestratorServiceLive(toOrchestratorConfig(cfg));

  return orchestrator.pipe(
    Layer.provide(
      Layer.mergeAll(
        daytonaLayers,
        sandboxScripts,
        WorkerPromptServiceLive,
        AgentRunnerLive,
        ArtifactStoreLive(path.join(process.cwd(), ".symphony/runs")),
        integrationStack,
        fpStack,
        WorkflowServiceLive,
        BunContext.layer,
      ),
    ),
  );
};

export const installSignalHandlers = (onSignal: Effect.Effect<void>) => {
  const stop = () => {
    Effect.runFork(onSignal);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
};

export const runPollLoop = (orchestrator: OrchestratorServiceShape, intervalMs: number) =>
  Effect.repeat(orchestrator.runOneTick, Schedule.spaced(Duration.millis(intervalMs)));

export type ProgramOptions = {
  readonly workflowPath?: string;
  readonly installSignals?: boolean;
  readonly orchestratorLayer?: Layer.Layer<OrchestratorService, unknown>;
};

export const makeProgram = (options: ProgramOptions = {}) =>
  Effect.gen(function* () {
    const workflowPath = options.workflowPath ?? parseCliOptions().workflow;
    const config = yield* loadWorkflowConfig(workflowPath);
    const orchestratorLayer = options.orchestratorLayer ?? buildPlatformLayer(config);

    yield* Effect.gen(function* () {
      const orchestrator = yield* OrchestratorService;
      const shutdown = yield* Deferred.make<void>();
      const removeHandlers =
        options.installSignals === false
          ? undefined
          : installSignalHandlers(Deferred.succeed(shutdown, undefined).pipe(Effect.asVoid));
      yield* Effect.addFinalizer(() =>
        removeHandlers === undefined ? Effect.void : Effect.sync(removeHandlers),
      );
      yield* Effect.raceFirst(
        runPollLoop(orchestrator, config.polling.intervalMs),
        Deferred.await(shutdown).pipe(Effect.zipRight(orchestrator.stop)),
      );
    }).pipe(Effect.scoped, Effect.provide(orchestratorLayer));
  }).pipe(Effect.provide(BunContext.layer), Effect.provide(structuredLoggerLayer()));

if (import.meta.main) {
  BunRuntime.runMain(makeProgram(), { disablePrettyLogger: true });
}
