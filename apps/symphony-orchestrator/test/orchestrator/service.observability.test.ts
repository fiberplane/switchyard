// Verifies the runOne happy-path emits one log line per state-flow row in the
// umbrella spec, and that issue/sandbox annotation context is set at the
// runOne boundary (no per-call site annotateLogs needed).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { structuredLoggerLayer } from "../../src/observability/logger.js";
import {
  OrchestratorService,
  type OrchestratorServiceConfig,
} from "../../src/orchestrator/service.js";
import { AgentRunner } from "../../src/runner/service.js";
import { fixtureEligible } from "./test-helpers/fixture-issue.js";
import {
  makeArtifactStoreMock,
  makeDaytonaAdapterMock,
  makeDaytonaSessionMock,
  makeFpMock,
  makeIntegrationMock,
  makeStubAgentRunner,
} from "./test-helpers/mocks.js";
import { wire, writeFakeCodexAuth } from "./test-helpers/wire.js";

const baseConfig = (codexAuthHostPath: string): OrchestratorServiceConfig => ({
  maxConcurrentAgents: 1,
  turnTimeoutMs: 60_000,
  snapshotName: "switchyard-codex-bun-test",
  autoStopInterval: 15,
  autoDeleteInterval: -1,
  codexAuthHostPath,
  repoPath: "/workspace/repo",
  source: { kind: "archive" },
  fpRest: { remote: "rest-api" },
});

let codexAuthPath: string;

beforeEach(async () => {
  codexAuthPath = await Effect.runPromise(
    writeFakeCodexAuth().pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

afterEach(() => {});

describe("OrchestratorService.runOne — observability emissions", () => {
  test("happy path emits one log line per umbrella-spec state-flow row, with annotation context", async () => {
    const issue = fixtureEligible("happy");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: [] });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);
    const agentRunner = Layer.succeed(
      AgentRunner,
      makeStubAgentRunner({
        kind: "completed",
        result: {},
        events: [],
      }),
    );

    const lines: Record<string, unknown>[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOne(issue);
      }).pipe(
        Effect.provide(wire({ fp, daytona, session, integration, artifact, config, agentRunner })),
        Effect.provide(
          structuredLoggerLayer({
            sink: (line) => {
              lines.push(JSON.parse(line) as Record<string, unknown>);
            },
          }),
        ),
      ),
    );

    const messages = lines.map((l) => l.message);
    const expectedOrder = [
      "claim.acquired",
      "sandbox.created",
      "source.uploaded",
      "turn.started",
      "turn.completed",
      "bundle.decoded",
      "integration.succeeded",
      "fp.done",
    ];
    for (const expected of expectedOrder) {
      expect(messages).toContain(expected);
    }
    // Order: each happy-path message appears in the listed sequence.
    const indexOf = (msg: string) => messages.indexOf(msg);
    for (let i = 1; i < expectedOrder.length; i++) {
      expect(indexOf(expectedOrder[i]!)).toBeGreaterThan(indexOf(expectedOrder[i - 1]!));
    }

    // Annotation context flows automatically: every post-claim emission has
    // issue_id / issue_display_id / attempt; everything from sandbox.created
    // onward also carries sandbox_id.
    const claim = lines.find((l) => l.message === "claim.acquired")!;
    expect(claim.issue_id).toBe(issue.detail.id);
    expect(claim.issue_display_id).toBe(issue.detail.displayId);
    expect(claim.attempt).toBe(1);

    const turnCompleted = lines.find((l) => l.message === "turn.completed")!;
    expect(turnCompleted.sandbox_id).toBeDefined();
    expect(turnCompleted.issue_id).toBe(issue.detail.id);

    const fpDone = lines.find((l) => l.message === "fp.done")!;
    expect(fpDone.branch).toBe("symphony/happy");
  });
});
