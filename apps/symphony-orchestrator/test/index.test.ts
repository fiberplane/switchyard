import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Deferred, Effect, Fiber, Ref } from "effect";

import { DaytonaAdapter } from "../src/daytona/daytona.adapter.js";
import { DaytonaSession } from "../src/daytona/daytona.session.js";
import {
  buildDaytonaLayers,
  installSignalHandlers,
  makeProgram,
  parseCliOptions,
  resolveHostRepoRoot,
  toDaytonaConfig,
  toOrchestratorConfig,
} from "../src/index.js";
import { WorkflowDecodeError, WorkflowFileMissing } from "../src/workflow/errors.js";
import type { WorkflowConfig } from "../src/workflow/models.js";
import { TestOrchestratorServiceLive } from "./orchestrator/test-helpers/test-orchestrator-service.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const originalCwd = process.cwd();

beforeAll(() => {
  process.chdir(appRoot);
});

afterAll(() => {
  process.chdir(originalCwd);
});

const fixtureConfig: WorkflowConfig = {
  tracker: {
    kind: "fp",
    dispatchFilter: { property: "symphony_ready", value: "true" },
  },
  polling: { intervalMs: 50 },
  agent: { maxConcurrentAgents: 1, maxAttempts: 1 },
  sandbox: {
    kind: "daytona",
    snapshot: "snapshot",
    language: "typescript",
    autoStopInterval: 15,
    autoDeleteInterval: -1,
    repoPath: "/workspace/repo",
    sourceStrategy: "archive",
    artifactStrategy: "bundle",
  },
  codex: {
    command: "codex app-server",
    turnTimeoutMs: 1000,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    sandboxPolicy: { type: "dangerFullAccess" },
  },
  integration: { branchPrefix: "symphony/" },
};

describe("orchestrator entrypoint wiring", () => {
  test("parses --workflow and defaults to ./WORKFLOW.md", () => {
    expect(parseCliOptions([])).toEqual({ workflow: "./WORKFLOW.md" });
    expect(parseCliOptions(["--workflow", "/tmp/example.yml"])).toEqual({
      workflow: "/tmp/example.yml",
    });
  });

  test("bridges workflow config into Daytona and orchestrator config", () => {
    const hostConfig = {
      daytona: {
        apiKey: "key",
        apiUrl: "http://localhost:3987",
        target: "local",
      },
    };

    expect(toDaytonaConfig(fixtureConfig.sandbox, hostConfig)).toEqual({
      apiUrl: "http://localhost:3987",
      apiKey: "key",
      target: "local",
      snapshotName: "snapshot",
    });
    expect(
      toOrchestratorConfig(fixtureConfig, { SWITCHYARD_CODEX_AUTH: "/tmp/auth.json" }),
    ).toMatchObject({
      maxConcurrentAgents: 1,
      turnTimeoutMs: 1000,
      snapshotName: "snapshot",
      autoStopInterval: 15,
      autoDeleteInterval: -1,
      codexAuthHostPath: "/tmp/auth.json",
    });
  });

  test("constructs Daytona Layers without probing when disabled", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DaytonaAdapter;
        yield* DaytonaSession;
      }).pipe(
        Effect.provide(
          buildDaytonaLayers(
            toDaytonaConfig(fixtureConfig.sandbox, {
              daytona: {
                apiKey: "key",
                apiUrl: "http://localhost:3987",
                target: "local",
              },
            }),
            { probeOnInit: false },
          ),
        ),
      ),
    );
  });

  test("resolves the host repo root from a nested application cwd", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "swy-entrypoint-root-"));
    const nested = join(repoDir, "apps/symphony-orchestrator");
    try {
      await Bun.$`mkdir -p ${nested}`;
      await Bun.$`git init --initial-branch=main --quiet`.cwd(repoDir);

      expect(realpathSync(resolveHostRepoRoot(nested))).toBe(realpathSync(repoDir));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("boots with a test OrchestratorService and runs one tick before interruption", async () => {
    const count = await Effect.runPromise(
      Effect.gen(function* () {
        const tickCount = yield* Ref.make(0);
        const layer = TestOrchestratorServiceLive({
          runOneTick: Ref.update(tickCount, (value) => value + 1).pipe(
            Effect.as({ dispatched: [], skipped: [] }),
          ),
          stop: Effect.void,
        });
        const fiber = yield* Effect.fork(
          makeProgram({
            workflowPath: "test/fixtures/workflow.smoke.yml",
            installSignals: false,
            orchestratorLayer: layer,
          }),
        );
        yield* Effect.gen(function* () {
          const deadline = Date.now() + 1_000;
          while ((yield* Ref.get(tickCount)) === 0 && Date.now() < deadline) {
            yield* Effect.sleep("10 millis");
          }
        });
        yield* Fiber.interrupt(fiber);
        return yield* Ref.get(tickCount);
      }),
    );

    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("poll loop repeats with configured spacing", async () => {
    const count = await Effect.runPromise(
      Effect.gen(function* () {
        const tickCount = yield* Ref.make(0);
        const layer = TestOrchestratorServiceLive({
          runOneTick: Ref.update(tickCount, (value) => value + 1).pipe(
            Effect.as({ dispatched: [], skipped: [] }),
          ),
          stop: Effect.void,
        });
        const fiber = yield* Effect.fork(
          makeProgram({
            workflowPath: "test/fixtures/workflow.poll-fast.yml",
            installSignals: false,
            orchestratorLayer: layer,
          }),
        );
        yield* Effect.sleep("230 millis");
        yield* Fiber.interrupt(fiber);
        return yield* Ref.get(tickCount);
      }),
    );

    expect(count).toBeGreaterThanOrEqual(4);
  });

  test("SIGTERM handler invokes the registered shutdown effect", async () => {
    const count = await Effect.runPromise(
      Effect.gen(function* () {
        const stopCount = yield* Ref.make(0);
        const remove = installSignalHandlers(Ref.update(stopCount, (value) => value + 1));
        process.emit("SIGTERM");
        yield* Effect.sleep("10 millis");
        remove();
        return yield* Ref.get(stopCount);
      }),
    );

    expect(count).toBe(1);
  });

  test("SIGTERM stops the poll loop and runs orchestrator.stop before program exit", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tickStarted = yield* Deferred.make<void>();
        const stopCount = yield* Ref.make(0);
        const layer = TestOrchestratorServiceLive({
          runOneTick: Deferred.succeed(tickStarted, undefined).pipe(Effect.zipRight(Effect.never)),
          stop: Ref.update(stopCount, (value) => value + 1),
        });
        const fiber = yield* Effect.fork(
          makeProgram({
            workflowPath: "test/fixtures/workflow.poll-fast.yml",
            orchestratorLayer: layer,
          }),
        );
        yield* Deferred.await(tickStarted);
        process.emit("SIGTERM");
        const completion = yield* Effect.raceFirst(
          Fiber.join(fiber).pipe(Effect.as("done" as const)),
          Effect.sleep("1 second").pipe(Effect.as("timeout" as const)),
        );
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
        const stopped = yield* Ref.get(stopCount);
        return { completion, stopped };
      }),
    );

    expect(result).toEqual({ completion: "done", stopped: 1 });
  });

  test("surfaces missing workflow files", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        makeProgram({
          workflowPath: "test/fixtures/nope.yml",
          installSignals: false,
          orchestratorLayer: TestOrchestratorServiceLive({
            runOneTick: Effect.succeed({ dispatched: [], skipped: [] }),
            stop: Effect.void,
          }),
        }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(WorkflowFileMissing);
    }
  });

  test("surfaces malformed workflow files", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        makeProgram({
          workflowPath: "test/fixtures/workflow.invalid-missing-tracker.yml",
          installSignals: false,
          orchestratorLayer: TestOrchestratorServiceLive({
            runOneTick: Effect.succeed({ dispatched: [], skipped: [] }),
            stop: Effect.void,
          }),
        }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(WorkflowDecodeError);
      if (result.left instanceof WorkflowDecodeError) {
        expect(result.left.details).toContain("tracker");
      }
    }
  });
});
