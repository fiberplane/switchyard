// Layer mocks for orchestrator/service.ts unit tests. Each mock exposes a
// `calls` array (or similar) so tests can assert exact call ordering /
// arguments without spinning up real adapters. The DaytonaSession mock yields
// raw JSONL strings on `receive` so the real AgentRunner exercises its
// framing/parsing/dispatch path (§7 mock-layer decision: option a).

import { Effect, Queue, Stream } from "effect";

import type { ArtifactStoreShape } from "../../../src/artifact/store.js";
import { ArtifactDecodeError, ArtifactPathError } from "../../../src/artifact/errors.js";
import type { OrchestratorRecord, WorkerOutcome } from "../../../src/artifact/models.js";
import type { TurnOutcome } from "../../../src/runner/service.js";
import type { DaytonaAdapterShape } from "../../../src/daytona/daytona.adapter.js";
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
import type {
  DaytonaSessionShape,
  ProtocolStream as DaytonaProtocolStream,
} from "../../../src/daytona/daytona.session.js";
import type { CandidateScan, FpServiceShape } from "../../../src/fp/service.js";
import type { IntegrationServiceShape } from "../../../src/integration/service.js";
import type { IntegrationResult, SourceHandoff } from "../../../src/integration/models.js";
import type { WorkerPromptServiceShape } from "../../../src/prompt/service.js";
import type { RenderedPrompt } from "../../../src/prompt/models.js";
import type { AgentRunnerShape } from "../../../src/runner/service.js";
import type { SandboxScriptServiceShape } from "../../../src/sandbox-scripts/service.js";
import type { SandboxBundleResult } from "../../../src/sandbox-scripts/models.js";

export type FpCall =
  | { readonly kind: "fetchCandidates"; readonly running: ReadonlyArray<string> }
  | { readonly kind: "claimIssue"; readonly id: string }
  | { readonly kind: "setAttempt"; readonly id: string; readonly attempt: number }
  | { readonly kind: "addComment"; readonly id: string; readonly body: string }
  | { readonly kind: "markCompleted"; readonly id: string; readonly summary: string }
  | { readonly kind: "markNeedsAttention"; readonly id: string; readonly error: string }
  | { readonly kind: "setArtifact"; readonly id: string; readonly path: string };

export type FpMock = {
  readonly shape: FpServiceShape;
  readonly calls: ReadonlyArray<FpCall>;
};

export const makeFpMock = (overrides: {
  readonly fetchCandidates?: () => Effect.Effect<CandidateScan, never>;
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
    claimIssue: (id) =>
      Effect.sync(() => {
        calls.push({ kind: "claimIssue", id });
      }),
    setAttempt: (id, attempt) =>
      Effect.sync(() => {
        calls.push({ kind: "setAttempt", id, attempt });
      }),
    markCompleted: (id, summary) =>
      Effect.sync(() => {
        calls.push({ kind: "markCompleted", id, summary });
      }),
    markNeedsAttention: (id, error) =>
      Effect.sync(() => {
        calls.push({ kind: "markNeedsAttention", id, error });
      }),
    setArtifact: (id, path) =>
      Effect.sync(() => {
        calls.push({ kind: "setArtifact", id, path });
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
        return overrides?.createSandbox === undefined ? Effect.succeed(handle) : overrides.createSandbox();
      }),
    deleteSandbox: () => Effect.void,
    executeCommand: (h, command) =>
      Effect.sync(() => {
        calls.push({ kind: "executeCommand", handle: h, command });
        const result: DaytonaCommandResult = { exitCode: 0, stdout: "", stderr: "" };
        return result;
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
};

export const makeDaytonaSessionMock = (behavior: SessionMockBehavior): DaytonaSessionMock => {
  const sent: string[] = [];
  let sendIndex = 0;
  const shape: DaytonaSessionShape = {
    start: () =>
      Effect.gen(function* () {
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
            }) as Effect.Effect<
              void,
              DaytonaSessionInputError | DaytonaSessionNotFoundError
            >,
          waitExit: Effect.succeed({ exitCode: 0 }),
          close: Effect.void,
        };
        return stream;
      }),
  };
  return { shape, sent: () => [...sent] };
};

export type IntegrationMock = {
  readonly shape: IntegrationServiceShape;
  readonly prepareCalls: () => number;
  readonly integrateCalls: () => ReadonlyArray<IntegrationCall>;
};

type IntegrationCall = {
  readonly bundlePath: string;
  readonly issueId: string;
  readonly suffix: string | undefined;
};

export const makeIntegrationMock = (overrides: {
  readonly prepare?: () => Effect.Effect<SourceHandoff, never>;
  readonly integrate?: (
    bundlePath: string,
    issueId: string,
  ) => Effect.Effect<IntegrationResult, never>;
}): IntegrationMock => {
  let prepareN = 0;
  const integrateLog: IntegrationCall[] = [];
  const shape: IntegrationServiceShape = {
    prepareSourceHandoff: () =>
      Effect.suspend(() => {
        prepareN += 1;
        return overrides.prepare === undefined
          ? Effect.succeed({ baseRev: "deadbeef", archivePath: "/tmp/swy-source-fixture/source.tar.gz" })
          : overrides.prepare();
      }),
    integrateBundle: (bundlePath, issueId, options) =>
      Effect.suspend(() => {
        integrateLog.push({ bundlePath, issueId, suffix: options?.suffix });
        return overrides.integrate === undefined
          ? Effect.succeed({
              branch: `symphony/${issueId}`,
              commitsBeyondBase: 1,
              attempt: 1,
            })
          : overrides.integrate(bundlePath, issueId);
      }),
  };
  return {
    shape,
    prepareCalls: () => prepareN,
    integrateCalls: () => [...integrateLog],
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
  overrides: {
    readonly readOutcome?: () => Effect.Effect<WorkerOutcome, ArtifactPathError | ArtifactDecodeError>;
  } = {},
): ArtifactStoreMock => {
  const recordLog: Array<{
    readonly issueId: string;
    readonly attempt: number;
    readonly record: OrchestratorRecord;
  }> = [];
  const shape: ArtifactStoreShape = {
    runDir: (issueId, attempt) =>
      Effect.succeed(`${basePath}/runs/${issueId}/${attempt}`),
    listRuns: () => Effect.succeed([]),
    readOutcome: () =>
      Effect.suspend(() =>
        overrides.readOutcome === undefined
          ? Effect.succeed({ status: "completed", summary: "ok" } satisfies WorkerOutcome)
          : overrides.readOutcome(),
      ),
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
      content: `Prompt for ${input.issue.displayId} (attempt ${input.attempt})`,
      hostPath: "/tmp/swy-prompt-fixture/prompt.md",
      sandboxPath: "/tmp/prompt.md",
    } satisfies RenderedPrompt),
});

export const makeSandboxScriptMock = (): SandboxScriptServiceShape => ({
  setupRepo: () => Effect.void,
  finalizeBundle: (_handle, options) =>
    Effect.succeed({
      bundlePath: options.bundlePath,
      commitsBeyondBase: 1,
    } satisfies SandboxBundleResult),
});

// AgentRunner — for cycles that don't need the runner's framing path, a stub
// that returns a canned outcome is enough. Cycle 3 uses the real runner against
// the DaytonaSession mock; failure-mode cycles can swap to this stub when the
// failure originates outside the runner.
export const makeStubAgentRunner = (outcome: TurnOutcome): AgentRunnerShape => ({
  runTurn: () => Effect.succeed(outcome),
});
