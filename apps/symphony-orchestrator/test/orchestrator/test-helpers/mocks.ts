// Layer mocks for orchestrator/service.ts unit tests. Each mock exposes a
// `calls` array (or similar) so tests can assert exact call ordering /
// arguments without spinning up real adapters. The DaytonaSession mock yields
// raw JSONL strings on `receive` so the real AgentRunner exercises its
// framing/parsing/dispatch path (§7 mock-layer decision: option a).

import { Effect, Queue, Stream } from "effect";

import { ArtifactPathError } from "../../../src/artifact/errors.js";
import type { OrchestratorRecord } from "../../../src/artifact/models.js";
import type { ArtifactStoreShape } from "../../../src/artifact/store.js";
import type { DaytonaAdapterShape } from "../../../src/daytona/daytona.adapter.js";
import type {
  DaytonaSessionShape,
  ProtocolStream as DaytonaProtocolStream,
} from "../../../src/daytona/daytona.session.js";
import type {
  DaytonaSandboxNotFoundError,
  DaytonaSandboxOpError,
  DaytonaSessionInputError,
  DaytonaSessionLogError,
  DaytonaSessionNotFoundError,
} from "../../../src/daytona/errors.js";
import type {
  DaytonaCommandResult,
  DaytonaFileTransfer,
  DaytonaSandboxSpec,
  SandboxHandle,
} from "../../../src/daytona/models.js";
import type { CandidateScan, FpServiceShape } from "../../../src/fp/service.js";
import { SYMPHONY_PROPERTIES_DEFAULTS } from "../../../src/fp/symphony-properties.js";
import type { GithubCloneSourceHandoff } from "../../../src/integration/models.js";
import type { GithubCloneSourceOptions } from "../../../src/integration/service.js";
import type { IntegrationServiceShape } from "../../../src/integration/service.js";
import type { RenderedPrompt } from "../../../src/prompt/models.js";
import type { WorkerPromptServiceShape } from "../../../src/prompt/service.js";
import type { TurnOutcome } from "../../../src/runner/service.js";
import type { AgentRunnerShape } from "../../../src/runner/service.js";
import type { SandboxScriptServiceShape } from "../../../src/sandbox-scripts/service.js";

export type FpCall =
  | { readonly kind: "fetchCandidates"; readonly running: ReadonlyArray<string> }
  | { readonly kind: "fetchIssueState"; readonly id: string }
  | { readonly kind: "claimIssue"; readonly id: string }
  | { readonly kind: "setAttempt"; readonly id: string; readonly attempt: number }
  | {
      readonly kind: "setRunMetadata";
      readonly id: string;
      readonly metadata: {
        readonly branch: string;
        readonly baseSha: string;
        readonly runId: string;
        readonly sandboxId: string;
      };
    }
  | {
      readonly kind: "setPrMetadata";
      readonly id: string;
      readonly metadata: {
        readonly branch: string;
        readonly prUrl: string;
        readonly prNumber: string;
        readonly baseSha: string;
        readonly headSha: string;
        readonly runId: string;
        readonly sandboxId: string;
      };
    }
  | { readonly kind: "addComment"; readonly id: string; readonly body: string }
  | { readonly kind: "markCompleted"; readonly id: string; readonly summary: string }
  | { readonly kind: "markNeedsAttention"; readonly id: string; readonly error: string };

export type FpMock = {
  readonly shape: FpServiceShape;
  readonly calls: ReadonlyArray<FpCall>;
};

export const makeFpMock = (overrides: {
  readonly fetchCandidates?: () => Effect.Effect<CandidateScan, never>;
  readonly fetchIssueState?: () => ReturnType<FpServiceShape["fetchIssueState"]>;
}): FpMock => {
  const calls: FpCall[] = [];
  const shape: FpServiceShape = {
    fetchCandidates: (running) =>
      Effect.suspend(() => {
        calls.push({ kind: "fetchCandidates", running: [...running] });
        return overrides.fetchCandidates === undefined
          ? Effect.succeed({ eligible: [], rejected: [] })
          : overrides.fetchCandidates();
      }),
    fetchIssueState: (id) =>
      Effect.suspend(() => {
        calls.push({ kind: "fetchIssueState", id });
        return overrides.fetchIssueState === undefined
          ? Effect.succeed({
              status: "in-progress",
              properties: { ...SYMPHONY_PROPERTIES_DEFAULTS, symphony_state: "active" },
            })
          : overrides.fetchIssueState();
      }),
    claimIssue: (id) =>
      Effect.sync(() => {
        calls.push({ kind: "claimIssue", id });
      }),
    setAttempt: (id, attempt) =>
      Effect.sync(() => {
        calls.push({ kind: "setAttempt", id, attempt });
      }),
    setRunMetadata: (id, metadata) =>
      Effect.sync(() => {
        calls.push({ kind: "setRunMetadata", id, metadata });
      }),
    setPrMetadata: (id, metadata) =>
      Effect.sync(() => {
        calls.push({ kind: "setPrMetadata", id, metadata });
      }),
    markCompleted: (id, summary) =>
      Effect.sync(() => {
        calls.push({ kind: "markCompleted", id, summary });
      }),
    markNeedsAttention: (id, error) =>
      Effect.sync(() => {
        calls.push({ kind: "markNeedsAttention", id, error });
      }),
    addComment: (id, body) =>
      Effect.sync(() => {
        calls.push({ kind: "addComment", id, body });
      }),
  };
  return { shape, calls };
};

// FpAdapter doesn't expose a `addComment`-ish method on FpServiceShape; the
// orchestrator's three-comment cadence (Dispatched / Turn completed / Final)
// composes against `markCompleted`/`markNeedsAttention` for the third comment,
// while the first two need an explicit comment surface. The orchestrator gets
// `addComment` from a small `FpComments` capability — see service.ts.
//
// For unit tests we expose comment captures via a separate getter so the mock
// stays narrow.

export type DaytonaAdapterCall =
  | { readonly kind: "createSandbox"; readonly spec: DaytonaSandboxSpec }
  | {
      readonly kind: "uploadFiles";
      readonly handle: SandboxHandle;
      readonly files: ReadonlyArray<DaytonaFileTransfer>;
    }
  | {
      readonly kind: "downloadFiles";
      readonly handle: SandboxHandle;
      readonly files: ReadonlyArray<DaytonaFileTransfer>;
    }
  | {
      readonly kind: "executeCommand";
      readonly handle: SandboxHandle;
      readonly command: string;
    };

export type DaytonaAdapterMock = {
  readonly shape: DaytonaAdapterShape;
  readonly calls: ReadonlyArray<DaytonaAdapterCall>;
  readonly handle: SandboxHandle;
};

const TEST_SANDBOX_HANDLE: SandboxHandle = {
  id: "sb-test-1",
  name: "swy-test-1",
  labels: {},
  envVars: {},
};

export const makeDaytonaAdapterMock = (overrides?: {
  readonly handle?: SandboxHandle;
  readonly createSandbox?: () => Effect.Effect<SandboxHandle, never>;
  readonly executeCommand?: (
    handle: SandboxHandle,
    command: string,
  ) => Effect.Effect<DaytonaCommandResult, DaytonaSandboxNotFoundError | DaytonaSandboxOpError>;
  readonly downloadFiles?: () => Effect.Effect<
    void,
    DaytonaSandboxNotFoundError | DaytonaSandboxOpError
  >;
}): DaytonaAdapterMock => {
  const calls: DaytonaAdapterCall[] = [];
  const handle = overrides?.handle ?? TEST_SANDBOX_HANDLE;
  const shape: DaytonaAdapterShape = {
    assertSnapshot: () => Effect.void,
    createSandbox: (spec) =>
      Effect.suspend(() => {
        calls.push({ kind: "createSandbox", spec });
        return overrides?.createSandbox === undefined
          ? Effect.succeed(handle)
          : overrides.createSandbox();
      }),
    deleteSandbox: () => Effect.void,
    executeCommand: (h, command) =>
      Effect.suspend(() => {
        calls.push({ kind: "executeCommand", handle: h, command });
        if (overrides?.executeCommand !== undefined) {
          return overrides.executeCommand(h, command);
        }
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      }),
    uploadFiles: (h, files) =>
      Effect.sync(() => {
        calls.push({ kind: "uploadFiles", handle: h, files: [...files] });
      }),
    downloadFiles: (h, files) =>
      Effect.suspend(() => {
        calls.push({ kind: "downloadFiles", handle: h, files: [...files] });
        return overrides?.downloadFiles === undefined ? Effect.void : overrides.downloadFiles();
      }),
  };
  return { shape, calls, handle };
};

export type SessionMockBehavior = {
  // Lines emitted on `receive` ahead of any send (e.g. server greeting).
  readonly preface?: ReadonlyArray<string>;
  // Per-send replies. Each emitted reply is a complete JSONL frame (the mock
  // appends the trailing newline). The orchestrator's runner sends 3 requests
  // (initialize, thread/start, turn/start) so 3 replies are typical, with the
  // 4th element being the terminal `turn/completed` notification (delivered
  // after the 3rd send is observed).
  readonly perSendReplies: ReadonlyArray<ReadonlyArray<string>>;
  // Optional terminal stream error emitted after replies drain. Models the
  // F7/F7b row (recv stream errored mid-turn).
  readonly receiveError?: DaytonaSessionLogError;
};

export type DaytonaSessionMock = {
  readonly shape: DaytonaSessionShape;
  // All bytes the runner sent over `send`, decoded back to UTF-8 strings.
  readonly sent: () => ReadonlyArray<string>;
  readonly starts: () => ReadonlyArray<{
    readonly handle: SandboxHandle;
    readonly command: string;
  }>;
};

export const makeDaytonaSessionMock = (behavior: SessionMockBehavior): DaytonaSessionMock => {
  const sent: string[] = [];
  const starts: Array<{ readonly handle: SandboxHandle; readonly command: string }> = [];
  const shape: DaytonaSessionShape = {
    start: (handle, command) =>
      Effect.gen(function* () {
        starts.push({ handle, command });
        // Per-call (per-runOne) sendIndex so multi-tick tests get a fresh
        // reply sequence on every session.start. Tests that need cumulative
        // tracking can read shape.sent() across ticks.
        let sendIndex = 0;
        // Receive frames are emitted via an unbounded queue. Pre-staged "preface"
        // frames go in immediately; per-send replies are pushed as the runner
        // observes each send (so requests reach pending state before responses
        // arrive — avoids the race where a response is dispatched to an empty
        // pending map).
        const queue = yield* Queue.unbounded<string>();
        for (const line of behavior.preface ?? []) {
          yield* Queue.offer(queue, `${line}\n`);
        }

        const queueStream = Stream.fromQueue(queue);
        const tail =
          behavior.receiveError === undefined
            ? Stream.empty
            : Stream.fromEffect(Effect.fail(behavior.receiveError));
        const receive = queueStream.pipe(Stream.concat(tail));

        const stream: DaytonaProtocolStream = {
          sessionId: "swyrd-test-session",
          commandId: "swyrd-test-cmd",
          receive,
          stderr: Stream.empty,
          send: (data) =>
            Effect.gen(function* () {
              sent.push(data);
              const replies = behavior.perSendReplies[sendIndex] ?? [];
              sendIndex += 1;
              for (const reply of replies) {
                yield* Queue.offer(queue, `${reply}\n`);
              }
            }) as Effect.Effect<void, DaytonaSessionInputError | DaytonaSessionNotFoundError>,
          waitExit: Effect.succeed({ exitCode: 0 }),
          close: Effect.void,
        };
        return stream;
      }),
  };
  return { shape, sent: () => [...sent], starts: () => [...starts] };
};

export type IntegrationMock = {
  readonly shape: IntegrationServiceShape;
  readonly prepareGithubCloneCalls: () => ReadonlyArray<GithubCloneSourceOptions>;
};

export const makeIntegrationMock = (overrides: {
  readonly prepareGithubClone?: (
    options: GithubCloneSourceOptions,
  ) => Effect.Effect<GithubCloneSourceHandoff, never>;
}): IntegrationMock => {
  const prepareGithubCloneLog: GithubCloneSourceOptions[] = [];
  const shape: IntegrationServiceShape = {
    prepareGithubCloneSourceHandoff: (options) =>
      Effect.suspend(() => {
        prepareGithubCloneLog.push(options);
        return overrides.prepareGithubClone === undefined
          ? Effect.succeed({
              kind: "githubClone" as const,
              repoUrl: options.repoUrl,
              baseBranch: options.baseBranch,
              baseSha: "0123456789abcdef0123456789abcdef01234567",
              repoPath: options.repoPath,
              branchName: options.branchName,
            })
          : overrides.prepareGithubClone(options);
      }),
  };
  return {
    shape,
    prepareGithubCloneCalls: () => [...prepareGithubCloneLog],
  };
};

export type ArtifactStoreMock = {
  readonly shape: ArtifactStoreShape;
  readonly records: () => ReadonlyArray<{
    readonly issueId: string;
    readonly attempt: number;
    readonly record: OrchestratorRecord;
  }>;
};

export const makeArtifactStoreMock = (
  basePath: string,
  _overrides: Record<string, never> = {},
): ArtifactStoreMock => {
  const recordLog: Array<{
    readonly issueId: string;
    readonly attempt: number;
    readonly record: OrchestratorRecord;
  }> = [];
  const shape: ArtifactStoreShape = {
    runDir: (issueId, attempt) => Effect.succeed(`${basePath}/runs/${issueId}/${attempt}`),
    listRuns: () => Effect.succeed([]),
    writeRecord: (issueId, attempt, record) =>
      Effect.sync(() => {
        recordLog.push({ issueId, attempt, record });
      }),
    readRecord: () =>
      Effect.fail(
        new ArtifactPathError({ path: basePath, operation: "readRecord", reason: "not stubbed" }),
      ),
  };
  return { shape, records: () => [...recordLog] };
};

export const makePromptMock = (): WorkerPromptServiceShape => ({
  renderPrompt: (input) =>
    Effect.succeed({
      content:
        input.source.kind === "githubClone"
          ? [
              `Prompt for ${input.issue.displayId} (attempt ${input.attempt})`,
              `branch=${input.source.branchName}`,
              `base=${input.source.baseSha}`,
              `run=${input.source.runId}`,
              `sandbox=${input.source.sandboxId}`,
              "properties=symphony_branch,symphony_pr_url,symphony_pr_number,symphony_base_sha,symphony_head_sha,symphony_run_id,symphony_sandbox_id",
            ].join("\n")
          : `Prompt for ${input.issue.displayId} (attempt ${input.attempt})`,
      hostPath: "/tmp/swy-prompt-fixture/prompt.md",
      sandboxPath: "/tmp/prompt.md",
    } satisfies RenderedPrompt),
});

export const makeSandboxScriptMock = (): SandboxScriptServiceShape => ({
  setupClone: () => Effect.void,
});

// AgentRunner — for cycles that don't need the runner's framing path, a stub
// that returns a canned outcome is enough. Cycle 3 uses the real runner against
// the DaytonaSession mock; failure-mode cycles can swap to this stub when the
// failure originates outside the runner.
export const makeStubAgentRunner = (outcome: TurnOutcome): AgentRunnerShape => ({
  runTurn: () => Effect.succeed(outcome),
});
