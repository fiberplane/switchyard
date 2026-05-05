// Unit tests for OrchestratorService.runOne (cycles 3-8) and runOneTick
// (cycles 9-12). Per §7 mock-layer decision (option a), the DaytonaSession is
// mocked at its raw-JSONL string surface so the real AgentRunner exercises its
// framing/parsing/dispatch path. Failure-mode cycles that originate outside
// the runner can swap in a stub AgentRunner via wire().

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";

import {
  OrchestratorService,
  type OrchestratorServiceConfig,
} from "../../src/orchestrator/service.js";
import { fixtureEligible } from "./test-helpers/fixture-issue.js";
import { ArtifactDecodeError } from "../../src/artifact/errors.js";
import { Layer } from "effect";
import {
  makeArtifactStoreMock,
  makeDaytonaAdapterMock,
  makeDaytonaSessionMock,
  makeFpMock,
  makeIntegrationMock,
  makeStubAgentRunner,
} from "./test-helpers/mocks.js";
import { AgentRunner } from "../../src/runner/service.js";
import { wire, writeFakeCodexAuth } from "./test-helpers/wire.js";

const baseConfig = (codexAuthHostPath: string): OrchestratorServiceConfig => ({
  maxConcurrentAgents: 1,
  turnTimeoutMs: 60_000,
  snapshotName: "symphony-test-base",
  autoStopInterval: 15,
  autoDeleteInterval: -1,
  codexAuthHostPath,
});

// Codex protocol responses the runner expects: initialize ack (sendIndex=0),
// thread/start ack (sendIndex=1), and turn/start ack + terminal
// turn/completed notification (sendIndex=2). Wire-shape stays compatible with
// real codex 0.128.0 (matches the captured fixtures the runner round-trips).
const codexResponses = (
  threadId = "thread-fixture",
  turnStatus: "completed" | "failed" | "interrupted" = "completed",
): ReadonlyArray<ReadonlyArray<string>> => [
  [
    JSON.stringify({
      id: 1,
      result: {
        userAgent: "switchyard-test/0.1",
        codexHome: "/workspace/codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    }),
  ],
  [
    JSON.stringify({
      id: 2,
      result: {
        thread: {
          id: threadId,
          forkedFromId: null,
          preview: "",
          ephemeral: true,
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          status: { type: "idle" },
          path: null,
          cwd: "/workspace/repo",
          cliVersion: "0.128.0",
          source: "vscode",
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
        },
      },
    }),
  ],
  [
    JSON.stringify({ id: 3, result: { ok: true } }),
    JSON.stringify({
      method: "turn/completed",
      params: { turn: { status: turnStatus } },
    }),
  ],
];

let codexAuthPath: string;

beforeEach(async () => {
  codexAuthPath = await Effect.runPromise(
    writeFakeCodexAuth().pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

afterEach(() => {
  // Tempdirs cleaned by OS / test infra; cheap to leak for unit tests.
});

describe("OrchestratorService.runOne — cycle 3 happy path", () => {
  test("drives a single eligible issue end-to-end and writes the integrated record", async () => {
    const issue = fixtureEligible("happy");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    const program = Effect.gen(function* () {
      const orch = yield* OrchestratorService;
      return yield* orch.runOne(issue);
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          wire({ fp, daytona, session, integration, artifact, config }),
        ),
      ),
    );

    expect(result.status).toBe("integrated");
    expect(result.attempt).toBe(1);
    expect(result.branch).toBe("symphony/happy");
    expect(result.summary).toBe("ok");
    expect(result.lastError).toBeUndefined();

    const fpKinds = fp.calls.map((call) => call.kind);
    expect(fpKinds).toEqual([
      "claimIssue",
      "setAttempt",
      "addComment", // dispatched
      "addComment", // integrating
      "setArtifact",
      "markCompleted",
    ]);

    // Cycle 8: three-comment cadence — verify the strings.
    const comments = fp.calls.flatMap((call) =>
      call.kind === "addComment" ? [call.body] : [],
    );
    expect(comments[0]).toMatch(/^Dispatched to sandbox `/);
    expect(comments[1]).toBe("Worker turn completed; integrating");
    const completed = fp.calls.find((call) => call.kind === "markCompleted");
    expect(completed?.kind).toBe("markCompleted");
    if (completed?.kind === "markCompleted") {
      expect(completed.summary).toBe("ok");
    }

    const setAttempt = fp.calls.find((call) => call.kind === "setAttempt");
    if (setAttempt?.kind === "setAttempt") {
      expect(setAttempt.attempt).toBe(1);
    }

    const setArtifact = fp.calls.find((call) => call.kind === "setArtifact");
    if (setArtifact?.kind === "setArtifact") {
      expect(setArtifact.path).toBe("symphony/happy");
    }

    // Step 8 batched upload: archive + prompt + codex auth in a single call.
    const upload = daytona.calls.find((call) => call.kind === "uploadFiles");
    if (upload?.kind === "uploadFiles") {
      expect(upload.files).toHaveLength(3);
      expect(upload.files.map((f) => f.dst)).toEqual([
        "/tmp/repo.tgz",
        "/tmp/prompt.md",
        "/workspace/codex-home/auth.json",
      ]);
    } else {
      throw new Error("expected uploadFiles call");
    }

    // The artifact record was written with status=integrated.
    expect(artifact.records()).toHaveLength(1);
    expect(artifact.records()[0]!.record.status).toBe("integrated");
    expect(artifact.records()[0]!.record.branch).toBe("symphony/happy");
  });
});

describe("OrchestratorService.runOne — cycle 4 empty bundle (F11)", () => {
  test("routes to needs-attention with locked error string when commitsBeyondBase=0", async () => {
    const issue = fixtureEligible("empty");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOne(issue);
      }).pipe(
        Effect.provide(
          wire({
            fp,
            daytona,
            session,
            integration,
            artifact,
            config,
            sandboxScripts: {
              setupRepo: () => Effect.void,
              finalizeBundle: (_handle, scriptOptions) =>
                Effect.succeed({
                  bundlePath: scriptOptions.bundlePath,
                  commitsBeyondBase: 0,
                }),
            },
          }),
        ),
      ),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.lastError).toBe("completed status with no commits");
    expect(result.branch).toBeUndefined();

    // Integration was NOT called for the empty-bundle path.
    expect(integration.integrateCalls()).toHaveLength(0);

    // markNeedsAttention fired; no markCompleted.
    expect(fp.calls.find((c) => c.kind === "markCompleted")).toBeUndefined();
    const na = fp.calls.find((c) => c.kind === "markNeedsAttention");
    expect(na?.kind).toBe("markNeedsAttention");
    if (na?.kind === "markNeedsAttention") {
      expect(na.error).toBe("completed status with no commits");
    }
  });
});

describe("OrchestratorService.runOne — cycle 5 malformed outcome (F10)", () => {
  test("routes to needs-attention but still integrates a forensic branch", async () => {
    const issue = fixtureEligible("malformed");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture", {
      readOutcome: () =>
        Effect.fail(
          new ArtifactDecodeError({
            path: "/tmp/swy-fixture/outcome.json",
            reason: "schema validation failed",
            details: "missing field summary",
          }),
        ),
    });
    const config = baseConfig(codexAuthPath);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOne(issue);
      }).pipe(
        Effect.provide(
          wire({ fp, daytona, session, integration, artifact, config }),
        ),
      ),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.lastError).toBe("malformed worker outcome");
    // Forensic integration still happened (plain branch name, no `-incomplete`).
    expect(integration.integrateCalls()).toHaveLength(1);
    expect(integration.integrateCalls()[0]!.suffix).toBeUndefined();
    expect(result.branch).toBe("symphony/malformed");

    // The recorded artifact reflects the forensic state (status=needs-attention).
    expect(artifact.records()).toHaveLength(1);
    expect(artifact.records()[0]!.record.status).toBe("needs-attention");
  });
});

describe("OrchestratorService.runOne — cycle 6 worker non-completed (F12)", () => {
  test("plain symphony/<id> branch, summary head as last_error, summary verbatim in fp comment", async () => {
    const issue = fixtureEligible("blocked");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture", {
      readOutcome: () =>
        Effect.succeed({
          status: "blocked",
          summary: "First line of summary\n\nMore detail below",
        }),
    });
    const config = baseConfig(codexAuthPath);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOne(issue);
      }).pipe(
        Effect.provide(wire({ fp, daytona, session, integration, artifact, config })),
      ),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.lastError).toBe("blocked: First line of summary");
    expect(result.branch).toBe("symphony/blocked"); // plain name (no -blocked suffix)

    // The fp comment carries the *full* summary verbatim (locked decision §7),
    // not the truncated last_error string.
    const na = fp.calls.find((c) => c.kind === "markNeedsAttention");
    if (na?.kind === "markNeedsAttention") {
      expect(na.error).toBe("First line of summary\n\nMore detail below");
    }
  });
});

describe("OrchestratorService.runOne — cycle 7 protocol stream failure (F7)", () => {
  test("non-completed turn outcome routes to needs-attention with `protocol stream <kind>` last_error", async () => {
    const issue = fixtureEligible("proto");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    // Stub the runner to return a `failed` outcome — drives the F7 row.
    const stubRunner = Layer.succeed(
      AgentRunner,
      makeStubAgentRunner({
        kind: "failed",
        reason: "model error: capacity exceeded",
        events: [],
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOne(issue);
      }).pipe(
        Effect.provide(
          wire({
            fp,
            daytona,
            session,
            integration,
            artifact,
            config,
            agentRunner: stubRunner,
          }),
        ),
      ),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.lastError).toBe("protocol stream failed: model error: capacity exceeded");

    // F7 path: integration NOT attempted.
    expect(integration.integrateCalls()).toHaveLength(0);
    // markNeedsAttention fired.
    expect(fp.calls.some((c) => c.kind === "markNeedsAttention")).toBe(true);
  });
});
