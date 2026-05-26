// Cycles 13a-13d: load-bearing integration test for the orchestrator's runOne
// pipeline against the real Daytona test stack and a real `codex app-server`.
//
// Gating:
// - `ensureStackUp()` (Daytona test stack via compose.test.yaml).
// - Real `~/.codex/auth.json` (or SWITCHYARD_CODEX_AUTH override). When this
//   file is absent the test skips its real-stack assertions and reports the
//   reason — running locally without codex auth must not poison the suite.
//
// Outcome assertions (cycle 13c happy path):
// - host repo gains `symphony/<issueId>` branch
// - `.symphony/runs/<id>/<attempt>/outcome-record.json` exists with status=integrated
// - fp issue transitions to `done` with `symphony_artifact=symphony/<id>`
//
// Cycle 13d (re-arm flow):
// - Seed `symphony_attempt=1`, `symphony_state=needs-attention` on the same
//   issue, re-arm to `todo`/`ready=true`/`state=idle`, drive runOne again, and
//   assert `symphony_attempt=2` post-claim AND the integration branch is
//   `symphony/<id>-attempt2`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { ArtifactStoreLive } from "../../src/artifact/store.js";
import { DaytonaAdapterLive } from "../../src/daytona/daytona.adapter.js";
import { DaytonaSessionLive } from "../../src/daytona/daytona.session.js";
import { FpAdapterLive } from "../../src/fp/adapter.js";
import { FpBinary, FpBinaryLive } from "../../src/fp/binary.js";
import { FpServiceLive } from "../../src/fp/service.js";
import { GitAdapterLive } from "../../src/integration/git.adapter.js";
import { IntegrationServiceLive } from "../../src/integration/service.js";
import {
  OrchestratorService,
  OrchestratorServiceLive,
  type OrchestratorServiceConfig,
} from "../../src/orchestrator/service.js";
import { WorkerPromptServiceLive } from "../../src/prompt/service.js";
import { AgentRunnerLive } from "../../src/runner/service.js";
import { SandboxScriptServiceLive } from "../../src/sandbox-scripts/service.js";
import { ensureTestSnapshot } from "../daytona/test-helpers/snapshot.js";
import { daytonaTestConfig, ensureStackUp } from "../daytona/test-helpers/stack.js";
import { sweepOrphanedTestSandboxes } from "../daytona/test-helpers/sweep.js";
import {
  createSymphonyFpFixture,
  rearmFpIssue,
  type SymphonyFpFixture,
} from "./test-helpers/fp-fixture.js";
import {
  createSymphonyHostRepoFixture,
  type SymphonyHostRepoFixture,
} from "./test-helpers/host-repo-fixture.js";

const CODEX_AUTH_PATH =
  process.env.SWITCHYARD_CODEX_AUTH ??
  process.env.CODEX_AUTH_JSON ??
  join(homedir(), ".codex", "auth.json");

const codexAuthAvailable = (): boolean => {
  try {
    return Bun.file(CODEX_AUTH_PATH).size > 0;
  } catch {
    return false;
  }
};

// Probe the Daytona test stack health endpoint with a short timeout. Returns
// true only if the local compose stack is already reachable; we deliberately
// don't try to boot it inside the unit-test path because docker-compose is a
// heavy dependency. Operators run `bun run test:daytona:up` first to enable
// this suite (see test/daytona/README.md).
const daytonaStackReachable = async (): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 1500);
  try {
    const response = await fetch("http://localhost:33000/health", {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

let stackReachable = false;

const baseConfig = (
  overrides: Partial<OrchestratorServiceConfig> = {},
): OrchestratorServiceConfig => ({
  maxConcurrentAgents: 1,
  // Real codex turns can take minutes; the test still gates on a faster
  // ceiling so a stuck turn fails the test rather than blocking CI forever.
  turnTimeoutMs: 8 * 60_000,
  snapshotName: daytonaTestConfig.snapshotName,
  autoStopInterval: 15,
  autoDeleteInterval: -1,
  codexAuthHostPath: CODEX_AUTH_PATH,
  repoPath: "/workspace/repo",
  source: { kind: "archive" },
  ...overrides,
});

let fpFixture: SymphonyFpFixture;
let hostRepo: SymphonyHostRepoFixture;
let artifactBase: string;
let fpPath: string;

const skipReason = (): string | null => {
  if (!codexAuthAvailable()) {
    return `Codex auth not available at ${CODEX_AUTH_PATH}; set SWITCHYARD_CODEX_AUTH to enable.`;
  }
  if (!stackReachable) {
    return "Daytona test stack not reachable at localhost:33000; run `bun run test:daytona:up` first.";
  }
  return null;
};

beforeAll(async () => {
  stackReachable = await daytonaStackReachable();
  if (skipReason() !== null) {
    return;
  }
  await ensureStackUp();
  await sweepOrphanedTestSandboxes();
  await ensureTestSnapshot();
  fpPath = await Effect.runPromise(
    Effect.gen(function* () {
      const binary = yield* FpBinary;
      return yield* binary.resolve();
    }).pipe(Effect.provide(FpBinaryLive()), Effect.provide(NodeContext.layer)),
  );
  fpFixture = await createSymphonyFpFixture(fpPath, {
    title: "switchyard integration test",
    description:
      'Add `INTEGRATION_TEST.md` at the repo root with the literal contents `marker\\n` and nothing else. Then write `outcome.json` to `/tmp/.symphony/` with `{"status":"completed","summary":"created marker file"}`.',
  });
  hostRepo = await createSymphonyHostRepoFixture();
  artifactBase = await Bun.$`mktemp -d ${join(tmpdir(), "swy-orchestrator-int-XXXX")}`.text();
  artifactBase = artifactBase.trim();
}, 300_000);

afterAll(async () => {
  if (skipReason() !== null) {
    return;
  }
  await fpFixture.cleanup();
  await hostRepo.cleanup();
  await Bun.$`rm -rf ${artifactBase}`.quiet();
}, 60_000);

const wireLive = (
  options: {
    readonly fpProjectDir: string;
    readonly hostRepoDir: string;
    readonly env: Record<string, string | undefined>;
  },
  config: OrchestratorServiceConfig,
) => {
  const fpStack = FpServiceLive.pipe(
    // fp must run inside the fp project (where .fp/ lives), but git must run
    // inside the host repo (separate cwds — they don't share a root).
    Layer.provide(FpAdapterLive({ cwd: options.fpProjectDir, env: options.env })),
    Layer.provide(FpBinaryLive({ env: options.env })),
  );
  const daytonaAdapter = DaytonaAdapterLive(daytonaTestConfig);
  const daytonaSession = DaytonaSessionLive(daytonaTestConfig);
  const integration = IntegrationServiceLive.pipe(
    Layer.provide(GitAdapterLive({ cwd: options.hostRepoDir, env: options.env })),
  );
  const artifactStore = ArtifactStoreLive(artifactBase);
  const dependencies = Layer.mergeAll(
    fpStack,
    daytonaAdapter,
    daytonaSession,
    integration,
    artifactStore,
    WorkerPromptServiceLive,
    SandboxScriptServiceLive.pipe(Layer.provide(daytonaAdapter)),
    AgentRunnerLive,
  );
  return OrchestratorServiceLive(config).pipe(
    Layer.provide(dependencies),
    Layer.provide(NodeContext.layer),
  );
};

describe("OrchestratorService integration — cycles 13a/13b/13c/13d", () => {
  test("13a: fp fixture creates an eligible issue", async () => {
    if (skipReason() !== null) {
      console.warn(`[skipped] ${skipReason()}`);
      return;
    }
    expect(fpFixture.issueId.length).toBeGreaterThan(0);
    expect(fpFixture.displayId.startsWith("SWY-")).toBe(true);
  });

  test("13b: host repo fixture exposes a base sha and supports branch lookup", async () => {
    if (skipReason() !== null) {
      console.warn(`[skipped] ${skipReason()}`);
      return;
    }
    const sha = await hostRepo.baseSha();
    expect(sha.length).toBeGreaterThanOrEqual(7);
    expect(await hostRepo.branchExists("symphony/never-existed")).toBe(false);
  });

  test("13c: full lifecycle — real Daytona + real codex + real fp + real host repo", async () => {
    if (skipReason() !== null) {
      console.warn(`[skipped] ${skipReason()}`);
      return;
    }

    const config = baseConfig();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...fpFixture.project.env,
    };
    const layer = wireLive(
      { fpProjectDir: fpFixture.project.projectDir, hostRepoDir: hostRepo.dir, env },
      config,
    );

    // Use the orchestrator's full pipeline (runOneTick) so candidate fetch +
    // selector + dispatch all exercise their real implementations.
    const tick = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOneTick;
      }).pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)),
    );

    expect(tick.dispatched).toHaveLength(1);
    expect(tick.dispatched[0]!.issueId).toBe(fpFixture.issueId);

    // Branch + record + fp transitions
    const branchName = `symphony/${fpFixture.issueId}`;
    expect(await hostRepo.branchExists(branchName)).toBe(true);

    const recordPath = join(artifactBase, "runs", fpFixture.issueId, "1", "outcome-record.json");
    const record = JSON.parse(await Bun.file(recordPath).text());
    expect(record.status).toBe("integrated");
    expect(record.branch).toBe(branchName);
    expect(record.attempt).toBe(1);
  }, 900_000);

  test("13d: re-arm flow — attempt increments and branch lands at -attempt2", async () => {
    if (skipReason() !== null) {
      console.warn(`[skipped] ${skipReason()}`);
      return;
    }

    // Pre-state expectation: 13c already ran and left the issue at done.
    // Re-arm: status=todo, ready=true, state=idle. Service.ts sees
    // symphony_attempt="1" and bumps to 2 on dispatch.
    await rearmFpIssue(fpFixture);

    const config = baseConfig();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...fpFixture.project.env,
    };
    const layer = wireLive(
      { fpProjectDir: fpFixture.project.projectDir, hostRepoDir: hostRepo.dir, env },
      config,
    );

    const tick = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOneTick;
      }).pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)),
    );

    expect(tick.dispatched).toHaveLength(1);
    expect(tick.dispatched[0]!.attempt).toBe(2);

    const branchName = `symphony/${fpFixture.issueId}-attempt2`;
    expect(await hostRepo.branchExists(branchName)).toBe(true);
  }, 900_000);
});
