// Unit tests for OrchestratorService.runOne (cycles 3-8) and runOneTick
// (cycles 9-12). Per §7 mock-layer decision (option a), the DaytonaSession is
// mocked at its raw-JSONL string surface so the real AgentRunner exercises its
// framing/parsing/dispatch path. Failure-mode cycles that originate outside
// the runner can swap in a stub AgentRunner via wire().

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { Layer } from "effect";

import { SYMPHONY_PROPERTIES_DEFAULTS } from "../../src/fp/symphony-properties.js";
import {
  OrchestratorService,
  type OrchestratorServiceConfig,
} from "../../src/orchestrator/service.js";
import { ProtocolRecvError } from "../../src/runner/errors.js";
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
  source: {
    kind: "githubClone",
    repoUrl: "https://github.com/fiberplane/switchyard.git",
    baseBranch: "main",
    artifactStrategy: "pr",
    githubToken: "github-token-that-must-not-render",
  },
  fpRest: {
    remote: "rest-api",
    token: "fp-token-that-must-not-render",
    serverUrl: "https://fp.example.test",
    workspace: "workspace-id",
    projectId: "project-id",
    projectPrefix: "SWYRD",
  },
});

const workerDoneState = (
  issueId: string,
  options: { readonly branch?: string; readonly sandboxId?: string } = {},
) => ({
  status: "done",
  properties: {
    ...SYMPHONY_PROPERTIES_DEFAULTS,
    symphony_state: "end" as const,
    symphony_branch: options.branch ?? `symphony/${issueId}`,
    symphony_pr_url: "https://github.com/fiberplane/switchyard/pull/123",
    symphony_pr_number: "123",
    symphony_base_sha: "0123456789abcdef0123456789abcdef01234567",
    symphony_head_sha: "89abcdef0123456789abcdef0123456789abcdef",
    symphony_run_id: `swy-swy-${issueId}-1`,
    symphony_sandbox_id: options.sandboxId ?? "sb-test-1",
  },
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
      params: { threadId, turn: { status: turnStatus } },
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
    const fp = makeFpMock({
      fetchIssueState: () => Effect.succeed(workerDoneState("happy")),
    });
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
      program.pipe(Effect.provide(wire({ fp, daytona, session, integration, artifact, config }))),
    );

    expect(result.status).toBe("integrated");
    expect(result.attempt).toBe(1);
    expect(result.branch).toBe("symphony/happy");
    expect(result.summary).toBe(
      "Worker opened PR https://github.com/fiberplane/switchyard/pull/123",
    );
    expect(result.lastError).toBeUndefined();

    const fpKinds = fp.calls.map((call) => call.kind);
    expect(fpKinds).toEqual([
      "claimIssue",
      "setAttempt",
      "setRunMetadata",
      "addComment", // dispatched
      "fetchIssueState",
    ]);

    const comments = fp.calls.flatMap((call) => (call.kind === "addComment" ? [call.body] : []));
    expect(comments[0]).toMatch(/^Dispatched to sandbox `/);
    expect(comments).toHaveLength(1);

    const setAttempt = fp.calls.find((call) => call.kind === "setAttempt");
    if (setAttempt?.kind === "setAttempt") {
      expect(setAttempt.attempt).toBe(1);
    }

    const upload = daytona.calls.find((call) => call.kind === "uploadFiles");
    if (upload?.kind === "uploadFiles") {
      expect(upload.files).toHaveLength(3);
      expect(upload.files.map((f) => f.dst)).toEqual([
        "/tmp/prompt.md",
        "/tmp/.symphony/codex-home/auth.json",
        "/tmp/.symphony/worker-env",
      ]);
    } else {
      throw new Error("expected uploadFiles call");
    }

    const sandbox = daytona.calls.find((call) => call.kind === "createSandbox");
    if (sandbox?.kind === "createSandbox") {
      expect(sandbox.spec.envVars.CODEX_HOME).toBe("/tmp/.symphony/codex-home");
    }

    // The artifact record was written with status=integrated.
    expect(artifact.records()).toHaveLength(1);
    expect(artifact.records()[0]!.record.status).toBe("integrated");
    expect(artifact.records()[0]!.record.branch).toBe("symphony/happy");
  });

  test("githubClone source uploads no archive and sets up the pinned remote checkout", async () => {
    const issue = fixtureEligible("clone");
    const fp = makeFpMock({
      fetchIssueState: () => Effect.succeed(workerDoneState("clone")),
    });
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const setupCloneCalls: unknown[] = [];
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
              setupClone: (_handle, options) =>
                Effect.sync(() => {
                  setupCloneCalls.push(options);
                }),
            },
          }),
        ),
      ),
    );

    expect(result.status).toBe("integrated");
    expect(result.lastError).toBeUndefined();
    expect(result.summary).toBe(
      "Worker opened PR https://github.com/fiberplane/switchyard/pull/123",
    );
    expect(result.branch).toBe("symphony/clone");
    expect(integration.prepareGithubCloneCalls()).toEqual([
      {
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        baseBranch: "main",
        repoPath: "/workspace/repo",
        branchName: "symphony/clone",
        githubToken: "github-token-that-must-not-render",
      },
    ]);
    const upload = daytona.calls.find((call) => call.kind === "uploadFiles");
    if (upload?.kind !== "uploadFiles") {
      throw new Error("expected uploadFiles call");
    }
    expect(upload.files.map((file) => file.dst)).toEqual([
      "/tmp/prompt.md",
      "/tmp/.symphony/codex-home/auth.json",
      "/tmp/.symphony/worker-env",
    ]);
    expect(JSON.stringify(upload.files)).not.toContain("repo.tgz");
    const command = session.starts()[0]?.command ?? "";
    expect(command).toContain(". '/tmp/.symphony/worker-env'");
    expect(command).toContain("rm -f '/tmp/.symphony/worker-env'");
    expect(command).toContain("cd '/workspace/repo' && codex app-server");
    expect(command).not.toContain("github-token-that-must-not-render");
    expect(command).not.toContain("fp-token-that-must-not-render");
    const promptFrames = JSON.stringify(session.sent());
    expect(promptFrames).toContain("symphony_pr_url");
    expect(promptFrames).toContain("swy-swy-clone-1");
    expect(promptFrames).toContain("sb-test-1");
    expect(promptFrames).not.toContain("github-token-that-must-not-render");
    expect(promptFrames).not.toContain("fp-token-that-must-not-render");
    expect(setupCloneCalls).toEqual([
      {
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        baseBranch: "main",
        baseSha: "0123456789abcdef0123456789abcdef01234567",
        repoPath: "/workspace/repo",
        branchName: "symphony/clone",
        symphonyDir: "/tmp/.symphony",
        githubToken: "github-token-that-must-not-render",
      },
    ]);
    expect(fp.calls.some((call) => call.kind === "markNeedsAttention")).toBe(false);
    expect(artifact.records()[0]?.record.status).toBe("integrated");
    expect(artifact.records()[0]?.record.branch).toBe("symphony/clone");
    expect(fp.calls.find((call) => call.kind === "setRunMetadata")).toEqual({
      kind: "setRunMetadata",
      id: "clone",
      metadata: {
        branch: "symphony/clone",
        baseSha: "0123456789abcdef0123456789abcdef01234567",
        runId: "swy-swy-clone-1",
        sandboxId: "sb-test-1",
      },
    });
    expect(
      daytona.calls.some(
        (call) => call.kind === "executeCommand" && call.command.includes("worker-env"),
      ),
    ).toBe(true);
    expect(
      daytona.calls.some(
        (call) =>
          call.kind === "executeCommand" &&
          call.command.includes("chmod 600") &&
          call.command.includes("worker-env"),
      ),
    ).toBe(true);
    expect(JSON.stringify(fp.calls)).not.toContain("symphony_artifact");
  });

  test("githubClone completed turn verifies worker-owned fp terminal metadata", async () => {
    const issue = fixtureEligible("clone-missing-metadata");
    const fp = makeFpMock({
      fetchIssueState: () =>
        Effect.succeed({
          status: "in-progress",
          properties: { ...SYMPHONY_PROPERTIES_DEFAULTS, symphony_state: "active" },
        }),
    });
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
              setupClone: () => Effect.void,
            },
          }),
        ),
      ),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.lastError).toContain("worker-owned PR metadata incomplete");
    expect(result.lastError).toContain("status=in-progress");
    expect(result.lastError).toContain("symphony_pr_url=missing");
    const park = fp.calls.find((call) => call.kind === "markNeedsAttention");
    expect(park?.kind).toBe("markNeedsAttention");
    if (park?.kind === "markNeedsAttention") {
      expect(park.error).toContain("worker-owned PR metadata incomplete");
    }
    expect(artifact.records()[0]?.record.status).toBe("needs-attention");
    expect(artifact.records()[0]?.record.integrationError).toContain(
      "worker-owned PR metadata incomplete",
    );
  });

  test("sandbox secret cleanup failure leaves an operator fp note", async () => {
    const issue = fixtureEligible("cleanup-note");
    const fp = makeFpMock({
      fetchIssueState: () => Effect.succeed(workerDoneState("cleanup-note")),
    });
    const daytona = makeDaytonaAdapterMock({
      executeCommand: (_handle, command) =>
        command.includes("rm -f")
          ? Effect.succeed({ exitCode: 7, stdout: "", stderr: "permission denied" })
          : Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOne(issue);
      }).pipe(Effect.provide(wire({ fp, daytona, session, integration, artifact, config }))),
    );

    expect(result.status).toBe("integrated");
    const comments = fp.calls.flatMap((call) => (call.kind === "addComment" ? [call.body] : []));
    expect(comments.some((body) => body.includes("Sandbox secret cleanup failed"))).toBe(true);
    expect(comments.some((body) => body.includes("/tmp/.symphony secret files"))).toBe(true);
  });

  test("sandboxLabelsFor can add E2E labels without losing canonical labels", async () => {
    const issue = fixtureEligible("labelled-clone");
    const fp = makeFpMock({
      fetchIssueState: () =>
        Effect.succeed(
          workerDoneState("labelled-clone", {
            sandboxId: "sb-test-1",
          }),
        ),
    });
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config: OrchestratorServiceConfig = {
      ...baseConfig(codexAuthPath),
      source: {
        kind: "githubClone",
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        baseBranch: "main",
        artifactStrategy: "pr",
      },
      sandboxLabelsFor: (_issue, _attempt, base) => ({
        ...base,
        app: "symphony-test",
        source: "remote-daytona",
        test_run_id: "e2e-run-123",
        owner: "qa",
      }),
    };

    await Effect.runPromise(
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
              setupClone: () => Effect.void,
            },
          }),
        ),
      ),
    );

    const sandbox = daytona.calls.find((call) => call.kind === "createSandbox");
    if (sandbox?.kind !== "createSandbox") {
      throw new Error("expected createSandbox call");
    }
    expect(sandbox.spec.labels).toMatchObject({
      fp_issue_id: "labelled-clone",
      fp_display_id: "SWY-labelled-clone",
      app: "symphony-test",
      source: "remote-daytona",
      test_run_id: "e2e-run-123",
      owner: "qa",
      attempt: "1",
      run_id: "swy-swy-labelled-clone-1",
    });
    expect(sandbox.spec.labels.created_at_ms).toMatch(/^\d+$/);
  });

  test("githubClone branchPrefix customizes worker-owned PR branch names", async () => {
    const issue = fixtureEligible("e2e-prefix");
    const fp = makeFpMock({
      fetchIssueState: () =>
        Effect.succeed(
          workerDoneState("e2e-prefix", {
            branch: "symphony/e2e/e2e-prefix",
            sandboxId: "sb-test-1",
          }),
        ),
    });
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config: OrchestratorServiceConfig = {
      ...baseConfig(codexAuthPath),
      source: {
        kind: "githubClone",
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        baseBranch: "main",
        artifactStrategy: "pr",
      },
      branchPrefix: "symphony/e2e/",
    };

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
              setupClone: () => Effect.void,
            },
          }),
        ),
      ),
    );

    expect(result.status).toBe("integrated");
    expect(result.branch).toBe("symphony/e2e/e2e-prefix");
  });

  test("githubClone transcript redacts fp, github, and codex auth tokens", async () => {
    const issue = fixtureEligible("clone-redact");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: [] });
    const integration = makeIntegrationMock({});
    const artifactRoot = mkdtempSync(join(tmpdir(), "swy-artifact-"));
    const artifact = makeArtifactStoreMock(artifactRoot);
    const authDir = mkdtempSync(join(tmpdir(), "swy-codex-auth-redact-"));
    const authPath = join(authDir, "auth.json");
    const codexAccessToken = "codex-access-token-that-must-not-render";
    const codexRefreshToken = "codex-refresh-token-that-must-not-render";
    writeFileSync(
      authPath,
      JSON.stringify({
        access_token: codexAccessToken,
        nested: { refresh_token: codexRefreshToken },
      }),
    );
    const config: OrchestratorServiceConfig = {
      ...baseConfig(authPath),
      source: {
        kind: "githubClone",
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        baseBranch: "main",
        artifactStrategy: "pr",
        githubToken: "github-token-that-must-not-render",
      },
    };
    const stubRunner = Layer.succeed(
      AgentRunner,
      makeStubAgentRunner({
        kind: "completed",
        result: {},
        events: [
          {
            method: "worker/log",
            params: {
              message:
                "github-token-that-must-not-render fp-token-that-must-not-render codex-access-token-that-must-not-render codex-refresh-token-that-must-not-render should redact",
            },
          } as never,
        ],
      }),
    );

    try {
      await Effect.runPromise(
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
              sandboxScripts: {
                setupClone: () => Effect.void,
              },
            }),
          ),
        ),
      );

      const transcript = readFileSync(
        join(artifactRoot, "runs", "clone-redact", "1", "transcript.jsonl"),
        "utf8",
      );
      expect(transcript).not.toContain("github-token-that-must-not-render");
      expect(transcript).not.toContain("fp-token-that-must-not-render");
      expect(transcript).not.toContain(codexAccessToken);
      expect(transcript).not.toContain(codexRefreshToken);
      expect(transcript).toContain("[redacted]");
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
      rmSync(authDir, { recursive: true, force: true });
    }
  });

  test("githubClone invalid codex auth JSON parks before uploading secrets", async () => {
    const issue = fixtureEligible("clone-invalid-auth");
    const authDir = mkdtempSync(join(tmpdir(), "swy-codex-auth-invalid-"));
    const authPath = join(authDir, "auth.json");
    writeFileSync(authPath, "{not json");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: [] });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(authPath);

    try {
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
                setupClone: () => Effect.void,
              },
            }),
          ),
        ),
      );

      expect(result.status).toBe("needs-attention");
      expect(result.lastError).toBe("sandbox upload failed: codex auth JSON decode failed");
      expect(daytona.calls.some((call) => call.kind === "uploadFiles")).toBe(false);
      expect(fp.calls.some((call) => call.kind === "markNeedsAttention")).toBe(true);
    } finally {
      rmSync(authDir, { recursive: true, force: true });
    }
  });

  test("githubClone setup failure does not upload the secret worker env bridge", async () => {
    const { SandboxScriptError } = await import("../../src/sandbox-scripts/errors.js");
    const issue = fixtureEligible("clone-setup-fail");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: [] });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config: OrchestratorServiceConfig = {
      ...baseConfig(codexAuthPath),
      source: {
        kind: "githubClone",
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        baseBranch: "main",
        artifactStrategy: "pr",
        githubToken: "github-token-that-must-not-render",
      },
    };

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
              setupClone: () =>
                Effect.fail(
                  new SandboxScriptError({
                    operation: "setupClone",
                    command: "git clone",
                    exitCode: 1,
                    stderr: "clone failed",
                  }),
                ),
            },
          }),
        ),
      ),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.lastError).toBe("sandbox setup failed: clone failed");
    expect(daytona.calls.some((call) => call.kind === "uploadFiles")).toBe(false);
  });
});

describe("OrchestratorService.runOneTick — cycles 9-12", () => {
  test("cycle 9: dispatches a single eligible candidate end-to-end", async () => {
    const issue = fixtureEligible("tick");
    const fp = makeFpMock({
      fetchCandidates: () => Effect.succeed({ eligible: [issue], rejected: [] }),
      fetchIssueState: () => Effect.succeed(workerDoneState("tick")),
    });
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    const tick = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOneTick;
      }).pipe(Effect.provide(wire({ fp, daytona, session, integration, artifact, config }))),
    );

    expect(tick.dispatched).toEqual([{ issueId: "tick", displayId: "SWY-tick", attempt: 1 }]);
    expect(tick.skipped).toEqual([]);
    // Confirm the issue actually went through runOne and verified worker-owned PR metadata.
    expect(fp.calls.some((c) => c.kind === "fetchIssueState")).toBe(true);
  });

  test("cycle 10: empty candidate set → no dispatch, no fp writes", async () => {
    const fp = makeFpMock({
      fetchCandidates: () => Effect.succeed({ eligible: [], rejected: [] }),
    });
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: [] });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    const tick = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOneTick;
      }).pipe(Effect.provide(wire({ fp, daytona, session, integration, artifact, config }))),
    );

    expect(tick.dispatched).toEqual([]);
    expect(tick.skipped).toEqual([]);
    // Only fetchCandidates was called — no claim / setAttempt / etc.
    const writes = fp.calls.filter((c) => c.kind !== "fetchCandidates");
    expect(writes).toEqual([]);
  });

  test("cycle 11: release-and-redispatch — first tick → needs-attention, second tick → another issue", async () => {
    const issueA = fixtureEligible("first");
    const issueB = fixtureEligible("second");

    let fetchN = 0;
    const fp = makeFpMock({
      fetchCandidates: () =>
        Effect.suspend(() => {
          fetchN += 1;
          // Tick 1: A is eligible. Tick 2: only B is eligible (A is now done /
          // needs-attention and the test seeds a fresh candidate scan).
          return Effect.succeed({
            eligible: fetchN === 1 ? [issueA] : [issueB],
            rejected: [],
          });
        }),
    });
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    // First runOne ends needs-attention because worker metadata is incomplete.
    // Second runOne also completes its lifecycle. Both dispatches must finish without slot blockage,
    // proving the running-set entry was released after the first runOne.
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    const layer = wire({ fp, daytona, session, integration, artifact, config });

    const tick1 = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOneTick;
      }).pipe(Effect.provide(layer)),
    );
    expect(tick1.dispatched).toEqual([{ issueId: "first", displayId: "SWY-first", attempt: 1 }]);

    const tick2 = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOneTick;
      }).pipe(Effect.provide(layer)),
    );
    expect(tick2.dispatched).toEqual([{ issueId: "second", displayId: "SWY-second", attempt: 1 }]);
  });
});

describe("OrchestratorService.runOne — failure-matrix routing (B2 fix)", () => {
  test("F3: sandbox create failure → markNeedsAttention with `sandbox create failed: ...`", async () => {
    const { DaytonaSandboxCreateError } = await import("../../src/daytona/errors.js");
    const issue = fixtureEligible("f3");
    const fp = makeFpMock({});
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    const daytona = makeDaytonaAdapterMock({
      createSandbox: () =>
        Effect.fail(
          new DaytonaSandboxCreateError({
            sandboxName: "swy-f3-1",
            reason: "no slots available",
          }),
        ) as unknown as Effect.Effect<never, never>,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        return yield* orch.runOne(issue);
      }).pipe(Effect.provide(wire({ fp, daytona, session, integration, artifact, config }))),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.lastError).toBe("sandbox create failed: no slots available");
    const na = fp.calls.find((c) => c.kind === "markNeedsAttention");
    expect(na).toBeDefined();
  });

  test("F5: setup-script failure → markNeedsAttention with `sandbox setup failed: ...`", async () => {
    const issue = fixtureEligible("f5");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    const { SandboxScriptError } = await import("../../src/sandbox-scripts/errors.js");
    const customScripts = {
      setupClone: () =>
        Effect.fail(
          new SandboxScriptError({
            operation: "setupClone" as const,
            command: "git clone",
            exitCode: 1,
            stderr: "clone failed",
          }),
        ) as Effect.Effect<never, never>,
    };

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
            sandboxScripts: customScripts,
          }),
        ),
      ),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.lastError).toBe("sandbox setup failed: clone failed");
    expect(fp.calls.some((c) => c.kind === "markNeedsAttention")).toBe(true);
  });
});

describe("OrchestratorService.stop", () => {
  test("interrupts in-flight runOne and parks issue at needs-attention", async () => {
    const issue = fixtureEligible("interrupt");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    // Session that pre-loads initialize+thread-start replies but withholds
    // the turn-completed notification, so runTurn hangs.
    const replies = codexResponses();
    const stallingSession = makeDaytonaSessionMock({
      perSendReplies: [replies[0]!, replies[1]!, [replies[2]![0]!]],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        const fiber = yield* Effect.fork(orch.runOne(issue));
        // Give runOne a moment to enter the turn.
        yield* Effect.sleep("100 millis");
        yield* orch.stop;
        // The fiber should be interrupted; await to drain.
        yield* Effect.fiberId.pipe(Effect.zipRight(Effect.exit(Effect.suspend(() => fiber.await))));
      }).pipe(
        Effect.provide(
          wire({ fp, daytona, session: stallingSession, integration, artifact, config }),
        ),
      ),
    );

    // Stop should have written markNeedsAttention with the locked string.
    const na = fp.calls.find((c) => c.kind === "markNeedsAttention");
    expect(na).toBeDefined();
    if (na?.kind === "markNeedsAttention") {
      expect(na.error).toBe("orchestrator interrupted by signal");
    }
  });

  test("interrupts in-flight runOne started by runOneTick", async () => {
    const issue = fixtureEligible("tick-interrupt");
    const fp = makeFpMock({
      fetchCandidates: () => Effect.succeed({ eligible: [issue], rejected: [] }),
    });
    const daytona = makeDaytonaAdapterMock();
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);

    const replies = codexResponses();
    const stallingSession = makeDaytonaSessionMock({
      perSendReplies: [replies[0]!, replies[1]!, [replies[2]![0]!]],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* OrchestratorService;
        const fiber = yield* Effect.fork(orch.runOneTick);
        yield* Effect.sleep("100 millis");
        yield* orch.stop;
        yield* Effect.fiberId.pipe(Effect.zipRight(Effect.exit(Effect.suspend(() => fiber.await))));
      }).pipe(
        Effect.provide(
          wire({ fp, daytona, session: stallingSession, integration, artifact, config }),
        ),
      ),
    );

    const na = fp.calls.find((c) => c.kind === "markNeedsAttention");
    expect(na).toBeDefined();
    if (na?.kind === "markNeedsAttention") {
      expect(na.error).toBe("orchestrator interrupted by signal");
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

    // markNeedsAttention fired.
    expect(fp.calls.some((c) => c.kind === "markNeedsAttention")).toBe(true);
  });

  test("githubClone non-completed turn does not download worker artifacts", async () => {
    const issue = fixtureEligible("clone-proto");
    const fp = makeFpMock({});
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config: OrchestratorServiceConfig = {
      ...baseConfig(codexAuthPath),
      source: {
        kind: "githubClone",
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        baseBranch: "main",
        artifactStrategy: "pr",
        githubToken: "github-token-that-must-not-render",
      },
    };
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
            sandboxScripts: { setupClone: () => Effect.void },
          }),
        ),
      ),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.lastError).toBe("protocol stream failed: model error: capacity exceeded");
    expect(daytona.calls.some((call) => call.kind === "downloadFiles")).toBe(false);
    expect(JSON.stringify(fp.calls)).not.toContain("symphony_artifact");
  });

  test("githubClone non-completed turn does not overwrite worker terminal needs-attention", async () => {
    const issue = fixtureEligible("clone-terminal");
    const fp = makeFpMock({
      fetchIssueState: () =>
        Effect.succeed({
          status: "in-progress",
          properties: {
            ...SYMPHONY_PROPERTIES_DEFAULTS,
            symphony_state: "needs-attention",
            symphony_branch: "symphony/clone-terminal",
            symphony_pr_url: "https://github.com/fiberplane/switchyard/pull/123",
            symphony_pr_number: "123",
            symphony_head_sha: "89abcdef0123456789abcdef0123456789abcdef",
          },
        }),
    });
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config: OrchestratorServiceConfig = {
      ...baseConfig(codexAuthPath),
      source: {
        kind: "githubClone",
        repoUrl: "https://github.com/fiberplane/switchyard.git",
        baseBranch: "main",
        artifactStrategy: "pr",
        githubToken: "github-token-that-must-not-render",
      },
    };
    const stubRunner = Layer.succeed(
      AgentRunner,
      makeStubAgentRunner({
        kind: "failed",
        reason: "model error after worker already finished",
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
            sandboxScripts: { setupClone: () => Effect.void },
          }),
        ),
      ),
    );

    expect(result.status).toBe("needs-attention");
    expect(fp.calls.some((call) => call.kind === "fetchIssueState")).toBe(true);
    expect(fp.calls.some((call) => call.kind === "markNeedsAttention")).toBe(false);
  });

  test("githubClone protocol error does not overwrite worker terminal done state", async () => {
    const issue = fixtureEligible("clone-terminal-protocol");
    const fp = makeFpMock({
      fetchIssueState: () =>
        Effect.succeed(
          workerDoneState("clone-terminal-protocol", {
            branch: "symphony/clone-terminal-protocol",
          }),
        ),
    });
    const daytona = makeDaytonaAdapterMock();
    const session = makeDaytonaSessionMock({ perSendReplies: codexResponses() });
    const integration = makeIntegrationMock({});
    const artifact = makeArtifactStoreMock("/tmp/swy-fixture");
    const config = baseConfig(codexAuthPath);
    const failingRunner = Layer.succeed(AgentRunner, {
      runTurn: () => Effect.fail(new ProtocolRecvError({ reason: "stream closed after handoff" })),
    });

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
            agentRunner: failingRunner,
            sandboxScripts: { setupClone: () => Effect.void },
          }),
        ),
      ),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.lastError).toBe("protocol stream error: stream closed after handoff");
    expect(fp.calls.some((call) => call.kind === "fetchIssueState")).toBe(true);
    expect(fp.calls.some((call) => call.kind === "markNeedsAttention")).toBe(false);
  });
});
