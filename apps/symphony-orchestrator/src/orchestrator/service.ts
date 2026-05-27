// Orchestrator runOne pipeline + per-tick poll. The per-issue lifecycle
// integrator that ties every other module into a working driver. The 20-step
// pipeline ordering, failure-matrix routing, and three-comment cadence are
// load-bearing; see docs/architecture/orchestrator-runone.md (drift-bound).

import { dirname } from "node:path";

import { Error as PlatformError, FileSystem } from "@effect/platform";
import { Context, Effect, Either, Fiber, Layer, Option, Ref, Schema, Stream } from "effect";

import type { ArtifactDecodeError, ArtifactPathError } from "../artifact/errors.js";
import type { OrchestratorRecord } from "../artifact/models.js";
import { ArtifactStore } from "../artifact/store.js";
import { DaytonaAdapter } from "../daytona/daytona.adapter.js";
import {
  DaytonaSession,
  type ProtocolStream as DaytonaProtocolStream,
} from "../daytona/daytona.session.js";
import type {
  DaytonaSessionInputError,
  DaytonaSessionLogError,
  DaytonaSessionNotFoundError,
} from "../daytona/errors.js";
import type { DaytonaSandboxSpec, SandboxHandle } from "../daytona/models.js";
import type { EligibleIssue } from "../fp/eligibility.js";
import { FpService } from "../fp/service.js";
import type { FpIssueState, WriteError } from "../fp/service.js";
import { symphonyBranchName, type GithubCloneSourceHandoff } from "../integration/models.js";
import { IntegrationService } from "../integration/service.js";
import { WorkerPromptService } from "../prompt/service.js";
import { ProtocolRecvError, ProtocolSendError } from "../runner/errors.js";
import { AgentRunner, type RunnerError, type TurnOutcome } from "../runner/service.js";
import type { ProtocolStream } from "../runner/transport.js";
import { SANDBOX_SYMPHONY_DIR } from "../sandbox-scripts/models.js";
import { SandboxScriptService } from "../sandbox-scripts/service.js";
import { shellQuote } from "../sandbox-scripts/shell-quote.js";
import { makeRedactor } from "../secrets/redactor.js";
import {
  DispatchError,
  FpWriteFailedError,
  MissingCodexAuthError,
  ProtocolStreamError,
  SandboxSetupError,
  TranscriptWriteError,
  UnparseableAttemptError,
  truncateLastError,
  type OrchestratorError,
} from "./errors.js";
import { select } from "./selector.js";
import {
  availableSlots,
  claimEffect,
  makeRunningSetRef,
  releaseEffect,
  type RunningSet,
} from "./state.js";
import { writeTranscript } from "./transcript.js";

// In-sandbox path the orchestrator copies host Codex auth into for this run.
// It lives outside the repo and is removed by the run scope finalizer after the
// worker turn closes.
const SANDBOX_CODEX_HOME = `${SANDBOX_SYMPHONY_DIR}/codex-home`;
const SANDBOX_CODEX_AUTH_PATH = `${SANDBOX_CODEX_HOME}/auth.json`;
const SANDBOX_GIT_CONFIG_PATH = `${SANDBOX_SYMPHONY_DIR}/gitconfig`;
const SANDBOX_WORKER_ENV_PATH = `${SANDBOX_SYMPHONY_DIR}/worker-env`;
const SANDBOX_GIT_ASKPASS_PATH = `${SANDBOX_SYMPHONY_DIR}/git-askpass`;
const SANDBOX_FP_REST_WORKDIR = `${SANDBOX_SYMPHONY_DIR}/fp-rest`;

// `export ...; cd <repoPath> && codex app-server` — NOT `exec codex app-server`.
// `exec` replaces the wrapper bash and defeats DaytonaSession's EXIT-trap
// workaround (daytona.session.ts:386-394), producing a false SIGKILL detection
// on clean codex exit. Locked in §7.
const codexAppServerCommand = (
  repoPath: string,
  options?: { readonly workerEnv: boolean },
): string => {
  const workerEnv =
    options?.workerEnv === true
      ? [
          `if [ -f ${shellQuote(SANDBOX_WORKER_ENV_PATH)} ]; then`,
          "set -a",
          `. ${shellQuote(SANDBOX_WORKER_ENV_PATH)}`,
          "set +a",
          `rm -f ${shellQuote(SANDBOX_WORKER_ENV_PATH)}`,
          "fi",
        ]
      : [];

  return [
    "set +x",
    ...workerEnv,
    `export GIT_CONFIG_GLOBAL=${shellQuote(SANDBOX_GIT_CONFIG_PATH)}`,
    "export GIT_CONFIG_SYSTEM=/dev/null",
    "export GIT_CONFIG_NOSYSTEM=1",
    "export GIT_CONFIG_COUNT=0",
    "unset GIT_CONFIG_PARAMETERS || true",
    `cd ${shellQuote(repoPath)} && codex app-server`,
  ].join("\n");
};

const prepareGithubCloneHandoff = (
  integration: Context.Tag.Service<IntegrationService>,
  config: OrchestratorServiceConfig,
  issueId: string,
  attempt: number,
): Effect.Effect<GithubCloneSourceHandoff, DispatchError> => {
  const branchName = symphonyBranchName(issueId, attempt);
  const githubCloneBranchName =
    config.branchPrefix === undefined
      ? branchName
      : `${config.branchPrefix.replace(/\/?$/u, "/")}${branchName.slice("symphony/".length)}`;

  return integration
    .prepareGithubCloneSourceHandoff({
      repoUrl: config.source.repoUrl,
      baseBranch: config.source.baseBranch,
      repoPath: config.repoPath,
      branchName: githubCloneBranchName,
      githubToken: config.source.githubToken,
    })
    .pipe(
      Effect.mapError(
        (err) => new DispatchError({ stage: "prepare-source", issueId, reason: err.stderr }),
      ),
    );
};

const workerPromptSource = (
  handoff: GithubCloneSourceHandoff,
  runId: string,
  sandboxId: string,
) => ({
  kind: "githubClone" as const,
  repoUrl: handoff.repoUrl,
  baseBranch: handoff.baseBranch,
  baseSha: handoff.baseSha,
  repoPath: handoff.repoPath,
  branchName: handoff.branchName,
  metadataPath: `${SANDBOX_SYMPHONY_DIR}/source.json`,
  runId,
  sandboxId,
  fpRestWorkdir: SANDBOX_FP_REST_WORKDIR,
});

const defaultRunId = (issue: EligibleIssue, attempt: number): string =>
  `swy-${issue.detail.displayId.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}-${attempt}`;

const shellExportLine = (name: string, value: string): string =>
  `export ${name}=${shellQuote(value)}`;

const renderWorkerEnvFile = (
  fpRest: OrchestratorServiceConfig["fpRest"],
  githubToken: string | undefined,
  metadata: {
    readonly branch: string;
    readonly baseSha: string;
    readonly runId: string;
    readonly sandboxId: string;
  },
): string => {
  const pairs: Array<readonly [string, string]> = [
    ["FP_REMOTE", fpRest.remote],
    ["GIT_TERMINAL_PROMPT", "0"],
    ["GIT_ASKPASS", SANDBOX_GIT_ASKPASS_PATH],
    ["SYMPHONY_BRANCH", metadata.branch],
    ["SYMPHONY_BASE_SHA", metadata.baseSha],
    ["SYMPHONY_RUN_ID", metadata.runId],
    ["SYMPHONY_SANDBOX_ID", metadata.sandboxId],
  ];

  if (fpRest.token !== undefined) {
    pairs.push(["FP_TOKEN", fpRest.token]);
  }
  if (fpRest.serverUrl !== undefined) {
    pairs.push(["FP_SERVER_URL", fpRest.serverUrl]);
  }
  if (fpRest.workspace !== undefined) {
    pairs.push(["FP_WORKSPACE", fpRest.workspace]);
  }
  if (fpRest.projectId !== undefined) {
    pairs.push(["FP_PROJECT_ID", fpRest.projectId]);
  }
  if (fpRest.projectPrefix !== undefined) {
    pairs.push(["FP_PROJECT_PREFIX", fpRest.projectPrefix]);
  }
  if (githubToken !== undefined) {
    pairs.push(["GITHUB_TOKEN", githubToken], ["GH_TOKEN", githubToken]);
  }

  return [
    "# generated by switchyard; uploaded outside the repo and removed on session start",
    ...pairs.map(([name, value]) => shellExportLine(name, value)),
    "",
  ].join("\n");
};

const collectJsonStringSecrets = (
  content: string,
  issueId: string,
  attempt: number,
): Effect.Effect<ReadonlyArray<string>, SandboxSetupError> => {
  const values = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length >= 16) {
        values.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        collect(entry);
      }
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) {
        collect(entry);
      }
    }
  };

  const decoded = Schema.decodeUnknownEither(Schema.parseJson(Schema.Unknown))(content);
  if (Either.isLeft(decoded)) {
    return Effect.fail(
      new SandboxSetupError({
        issueId,
        attempt,
        stage: "upload",
        reason: "codex auth JSON decode failed",
      }),
    );
  }
  collect(decoded.right);
  return Effect.succeed(Array.from(values));
};

type GithubCloneCompletion = {
  readonly branch: string;
  readonly prUrl: string;
  readonly prNumber: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly runId: string;
  readonly sandboxId: string;
};

const missingGithubCloneCompletionReason = (details: ReadonlyArray<string>): string =>
  `worker-owned PR metadata incomplete: ${details.join(", ")}`;

const validateGithubCloneCompletion = (
  state: FpIssueState,
  expected: {
    readonly branch: string;
    readonly baseSha: string;
    readonly runId: string;
    readonly sandboxId: string;
  },
):
  | { readonly kind: "ok"; readonly completion: GithubCloneCompletion }
  | {
      readonly kind: "missing";
      readonly reason: string;
    } => {
  const problems: string[] = [];
  const properties = state.properties;

  if (state.status !== "done") {
    problems.push(`status=${state.status}`);
  }
  if (properties.symphony_state !== "end") {
    problems.push(`symphony_state=${properties.symphony_state}`);
  }

  const branch = properties.symphony_branch;
  const baseSha = properties.symphony_base_sha;
  const runId = properties.symphony_run_id;
  const sandboxId = properties.symphony_sandbox_id;
  const required = [
    ["symphony_branch", branch, expected.branch],
    ["symphony_base_sha", baseSha, expected.baseSha],
    ["symphony_run_id", runId, expected.runId],
    ["symphony_sandbox_id", sandboxId, expected.sandboxId],
  ] as const;
  for (const [key, actual, wanted] of required) {
    if (actual === undefined) {
      problems.push(`${key}=missing`);
    } else if (actual !== wanted) {
      problems.push(`${key}=mismatch`);
    }
  }

  const prUrl = properties.symphony_pr_url;
  if (prUrl === undefined) {
    problems.push("symphony_pr_url=missing");
  }
  const prNumber = properties.symphony_pr_number;
  if (prNumber === undefined) {
    problems.push("symphony_pr_number=missing");
  }
  const headSha = properties.symphony_head_sha;
  if (headSha === undefined) {
    problems.push("symphony_head_sha=missing");
  }

  if (
    problems.length > 0 ||
    branch === undefined ||
    baseSha === undefined ||
    runId === undefined ||
    sandboxId === undefined ||
    prUrl === undefined ||
    prNumber === undefined ||
    headSha === undefined
  ) {
    return { kind: "missing", reason: missingGithubCloneCompletionReason(problems) };
  }

  return {
    kind: "ok",
    completion: {
      branch,
      prUrl,
      prNumber,
      baseSha,
      headSha,
      runId,
      sandboxId,
    },
  };
};

const verifyGithubCloneCompletion = (
  fp: Context.Tag.Service<FpService>,
  issueId: string,
  expected: {
    readonly branch: string;
    readonly baseSha: string;
    readonly runId: string;
    readonly sandboxId: string;
  },
): Effect.Effect<
  | { readonly kind: "ok"; readonly completion: GithubCloneCompletion }
  | {
      readonly kind: "missing";
      readonly reason: string;
    }
> =>
  fp.fetchIssueState(issueId).pipe(
    Effect.map((state) => validateGithubCloneCompletion(state, expected)),
    Effect.catchAll((error) =>
      Effect.logWarning("worker.handoff.read-failed").pipe(
        Effect.annotateLogs({ error_tag: error._tag }),
        Effect.as({
          kind: "missing" as const,
          reason: `worker-owned PR metadata read failed: ${error._tag}`,
        }),
      ),
    ),
  );

const cleanupSandboxSecrets = (
  daytona: Context.Tag.Service<DaytonaAdapter>,
  fp: Context.Tag.Service<FpService>,
  handle: SandboxHandle,
  issueId: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cleanup = yield* Effect.either(
      daytona.executeCommand(
        handle,
        [
          "set +x",
          `rm -f ${shellQuote(SANDBOX_WORKER_ENV_PATH)}`,
          `rm -f ${shellQuote(SANDBOX_CODEX_AUTH_PATH)}`,
          `rmdir ${shellQuote(SANDBOX_CODEX_HOME)} 2>/dev/null || true`,
        ].join("\n"),
      ),
    );

    const failureReason = Either.match(cleanup, {
      onLeft: (error) => error.reason,
      onRight: (result) =>
        result.exitCode === 0 ? undefined : `cleanup command exited ${result.exitCode}`,
    });
    if (failureReason === undefined) {
      return;
    }

    const note = `Sandbox secret cleanup failed for Daytona sandbox ${handle.id}; manually inspect and remove /tmp/.symphony secret files if the sandbox is retained.`;
    yield* Effect.logWarning("sandbox.secret-cleanup.failed").pipe(
      Effect.annotateLogs({
        issue_id: issueId,
        sandbox_id: handle.id,
        reason: truncateLastError(failureReason),
      }),
    );
    yield* fp.addComment(issueId, note).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning("sandbox secret cleanup fp comment failed").pipe(
          Effect.annotateLogs({
            issue_id: issueId,
            sandbox_id: handle.id,
            error_tag: error._tag,
          }),
        ),
      ),
    );
  });

const prepareSandboxSecretDirs = (
  daytona: Context.Tag.Service<DaytonaAdapter>,
  handle: SandboxHandle,
): Effect.Effect<void, SandboxSetupError> =>
  daytona
    .executeCommand(
      handle,
      [
        "set +x",
        `mkdir -p ${shellQuote(SANDBOX_CODEX_HOME)}`,
        `mkdir -p ${shellQuote(SANDBOX_FP_REST_WORKDIR)}`,
      ].join("\n"),
    )
    .pipe(
      Effect.mapError(
        (err): SandboxSetupError =>
          new SandboxSetupError({
            issueId: handle.labels.fp_issue_id ?? "unknown",
            attempt: Number.parseInt(handle.labels.attempt ?? "0", 10) || 0,
            stage: "upload",
            reason: err.reason,
          }),
      ),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(
              new SandboxSetupError({
                issueId: handle.labels.fp_issue_id ?? "unknown",
                attempt: Number.parseInt(handle.labels.attempt ?? "0", 10) || 0,
                stage: "upload",
                reason: result.stderr,
              }),
            ),
      ),
    );

const restrictWorkerEnv = (
  daytona: Context.Tag.Service<DaytonaAdapter>,
  handle: SandboxHandle,
): Effect.Effect<void, SandboxSetupError> =>
  daytona.executeCommand(handle, `chmod 600 ${shellQuote(SANDBOX_WORKER_ENV_PATH)}`).pipe(
    Effect.mapError(
      (err): SandboxSetupError =>
        new SandboxSetupError({
          issueId: handle.labels.fp_issue_id ?? "unknown",
          attempt: Number.parseInt(handle.labels.attempt ?? "0", 10) || 0,
          stage: "upload",
          reason: err.reason,
        }),
    ),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new SandboxSetupError({
              issueId: handle.labels.fp_issue_id ?? "unknown",
              attempt: Number.parseInt(handle.labels.attempt ?? "0", 10) || 0,
              stage: "upload",
              reason: result.stderr,
            }),
          ),
    ),
  );

const shouldSkipGithubCloneCrashPark = (
  fp: Context.Tag.Service<FpService>,
  issueId: string,
): Effect.Effect<boolean> =>
  fp.fetchIssueState(issueId).pipe(
    Effect.map(
      (state) =>
        state.status === "done" ||
        state.properties.symphony_state === "end" ||
        state.properties.symphony_state === "needs-attention",
    ),
    Effect.catchAll((err) =>
      Effect.logWarning("worker terminal-state check failed").pipe(
        Effect.annotateLogs({
          operation: "fetchIssueState",
          error_tag: "_tag" in err ? err._tag : "unknown",
        }),
        Effect.as(true),
      ),
    ),
  );

export type OrchestratorServiceConfig = {
  // From WorkflowConfig.agent.maxConcurrentAgents.
  readonly maxConcurrentAgents: number;
  // From WorkflowConfig.codex.turnTimeoutMs.
  readonly turnTimeoutMs: number;
  // From WorkflowConfig.sandbox.snapshot.
  readonly snapshotName: string;
  // From WorkflowConfig.sandbox.autoStopInterval (15 default).
  readonly autoStopInterval: number;
  // From WorkflowConfig.sandbox.autoDeleteInterval (-1 default).
  readonly autoDeleteInterval: number;
  // Host path to the Codex auth.json copied into the sandbox Codex home.
  // Resolved by index.ts via env → ~/.codex/auth.json. Pre-claim missing →
  // MissingCodexAuthError → log + skip.
  readonly codexAuthHostPath: string;
  readonly repoPath: string;
  readonly source: {
    readonly kind: "githubClone";
    readonly repoUrl: string;
    readonly baseBranch: string;
    readonly artifactStrategy: "pr";
    readonly githubToken?: string | undefined;
  };
  readonly fpRest: {
    readonly remote: "rest-api";
    readonly token?: string | undefined;
    readonly serverUrl?: string | undefined;
    readonly workspace?: string | undefined;
    readonly projectId?: string | undefined;
    readonly projectPrefix?: string | undefined;
  };
  readonly branchPrefix?: string | undefined;
  // Optional sandbox-name template. Defaults to `swy-<displayId>-<attempt>`.
  readonly sandboxNameFor?: (issue: EligibleIssue, attempt: number) => string;
  readonly sandboxLabelsFor?: (
    issue: EligibleIssue,
    attempt: number,
    baseLabels: Record<string, string>,
  ) => Record<string, string>;
};

export type RunOneResult = {
  readonly issueId: string;
  readonly attempt: number;
  readonly status: "integrated" | "needs-attention";
  // Branch is present when the worker-owned PR handoff reached the post-turn
  // verification gate.
  readonly branch: string | undefined;
  readonly summary: string | undefined;
  readonly lastError: string | undefined;
};

export type TickDispatch = {
  readonly issueId: string;
  readonly displayId: string;
  readonly attempt: number;
};

export type TickSkip = {
  readonly issueId: string;
  readonly displayId: string;
  readonly reason: string;
};

export type TickResult = {
  readonly dispatched: ReadonlyArray<TickDispatch>;
  readonly skipped: ReadonlyArray<TickSkip>;
};

export type OrchestratorServiceShape = {
  readonly runOneTick: Effect.Effect<TickResult, OrchestratorError, FileSystem.FileSystem>;
  readonly runOne: (
    issue: EligibleIssue,
  ) => Effect.Effect<RunOneResult, OrchestratorError, FileSystem.FileSystem>;
  readonly stop: Effect.Effect<void>;
};

export class OrchestratorService extends Context.Tag("OrchestratorService")<
  OrchestratorService,
  OrchestratorServiceShape
>() {}

// Bridge between the DaytonaSession's string-typed ProtocolStream and the
// runner's Uint8Array-typed ProtocolStream. The codex app-server speaks
// newline-delimited JSON-RPC over stdio, so a UTF-8 round-trip preserves the
// wire shape and the runner's framer/parser handles partial chunks correctly.
const bridgeProtocolStream = (daytona: DaytonaProtocolStream): ProtocolStream => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  return {
    send: (bytes) =>
      daytona
        .send(decoder.decode(bytes))
        .pipe(
          Effect.mapError(
            (err: DaytonaSessionInputError | DaytonaSessionNotFoundError) =>
              new ProtocolSendError({ reason: err.reason }),
          ),
        ),
    receive: daytona.receive.pipe(
      Stream.map((chunk: string) => encoder.encode(chunk)),
      Stream.mapError(
        (err: DaytonaSessionLogError) => new ProtocolRecvError({ reason: err.reason }),
      ),
    ),
  };
};

// Parse symphony_attempt from issue properties. Locked rule (§7): unparseable
// raw value parks needs-attention with `unparseable symphony_attempt: <raw>`;
// undefined → 0 (no prior attempt).
const parsePriorAttempt = (
  issueId: string,
  raw: string | undefined,
): Effect.Effect<number, UnparseableAttemptError> => {
  if (raw === undefined) {
    return Effect.succeed(0);
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return Effect.fail(new UnparseableAttemptError({ issueId, raw }));
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Effect.fail(new UnparseableAttemptError({ issueId, raw }));
  }
  return Effect.succeed(parsed);
};

const defaultSandboxName = (issue: EligibleIssue, attempt: number): string =>
  // The display id may contain characters that aren't sandbox-name-safe
  // (Daytona accepts a-z, 0-9, hyphen). Lowercase + replace anything else.
  `swy-${issue.detail.displayId.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}-${attempt}`;

// Map any RunnerError into a uniform ProtocolStreamError. The runner's error
// channel is ProtocolFraming/ParseError/SendError/RecvError +
// RunnerProtocol/Request/RequestTimeout/SessionClosed/TurnTimeout; the F7/F7b
// row collapses all of them.
const runnerErrorToProtocol = (
  issueId: string,
  attempt: number,
  err: RunnerError,
): ProtocolStreamError => {
  const reason = "reason" in err && typeof err.reason === "string" ? err.reason : err._tag;
  return new ProtocolStreamError({
    issueId,
    attempt,
    kind: "error",
    reason,
  });
};

// Map a TurnOutcome non-completed kind into a ProtocolStreamError. Distinct
// from runner-error → ProtocolStreamError because TurnOutcome.failed/cancelled/
// input-required is the runner returning a typed outcome (not failing the
// effect) for protocol-level terminal events.
const turnOutcomeToProtocol = (
  issueId: string,
  attempt: number,
  outcome: TurnOutcome,
): ProtocolStreamError | null => {
  switch (outcome.kind) {
    case "completed":
      return null;
    case "failed":
    case "cancelled":
      return new ProtocolStreamError({
        issueId,
        attempt,
        kind: outcome.kind,
        reason: outcome.reason,
      });
    case "input-required":
      return new ProtocolStreamError({
        issueId,
        attempt,
        kind: "input-required",
        reason:
          typeof outcome.prompt === "string" ? outcome.prompt : JSON.stringify(outcome.prompt),
      });
  }
};

// Run a single dispatched issue end-to-end through the remote Daytona pipeline.
// Outer scope owns: state-claim release finalizer plus prompt/env/secret
// cleanup. Inner Effect.scoped(runTurn) owns the codex app-server session
// lifetime and closes it before post-turn fp/PR metadata verification.
const runOneImpl =
  (
    config: OrchestratorServiceConfig,
    ref: Ref.Ref<RunningSet>,
    fp: Context.Tag.Service<FpService>,
    daytona: Context.Tag.Service<DaytonaAdapter>,
    session: Context.Tag.Service<DaytonaSession>,
    integration: Context.Tag.Service<IntegrationService>,
    artifactStore: Context.Tag.Service<ArtifactStore>,
    prompt: Context.Tag.Service<WorkerPromptService>,
    scripts: Context.Tag.Service<SandboxScriptService>,
    runner: Context.Tag.Service<AgentRunner>,
  ) =>
  (issue: EligibleIssue): Effect.Effect<RunOneResult, OrchestratorError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const issueId = issue.detail.id;
      const displayId = issue.detail.displayId;

      // Step 4 (preview): compute the new attempt number. Pre-claim because
      // the running-set entry needs the resolved attempt and an unparseable
      // value parks needs-attention WITHOUT entering the running set.
      const priorAttempt = yield* parsePriorAttempt(issueId, issue.properties.symphony_attempt);
      const attempt = priorAttempt + 1;
      const startedAt = new Date().toISOString();

      // Step 5: prepare source handoff. Pre-claim per §5b rule 1 — failure
      // here never writes fp; the tick handler logs + skips.
      const handoff = yield* prepareGithubCloneHandoff(integration, config, issueId, attempt);

      // Pre-claim host codex auth read (F2b in matrix). v1 demo path.
      const codexAuthExists = yield* fs.exists(config.codexAuthHostPath).pipe(
        Effect.mapError(
          (err: PlatformError.PlatformError) =>
            new MissingCodexAuthError({
              path: config.codexAuthHostPath,
              reason: err.message,
            }),
        ),
      );
      if (!codexAuthExists) {
        return yield* Effect.fail(
          new MissingCodexAuthError({
            path: config.codexAuthHostPath,
            reason: "file does not exist on host",
          }),
        );
      }

      // From this point on the issue has resources allocated. Step 3 + 4:
      // claim into running set with finalizer registered FIRST so it always
      // runs (success / failure / interrupt). Then write fp claim transition.
      // Both temp dirs are also cleaned via finalizers (LIFO order: temp dirs
      // are cleaned AFTER the running-set release because they're registered
      // later — but order doesn't matter for these independent resources).
      //
      // Post-claim failure-matrix routing (B2): the inner pipeline can fail
      // with SandboxSetupError / TranscriptWriteError / FpWriteFailedError.
      // Those tags get caught at the bottom of this
      // scoped block and routed to the prescribed markNeedsAttention write
      // before being absorbed into a `needs-attention` RunOneResult — so the
      // fp issue is NEVER left at status=in-progress without a last_error.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          // All emissions inside the post-claim scope inherit issue_id /
          // issue_display_id / attempt; sandbox_id is layered on after the
          // sandbox handle is created. Annotation context is set at the
          // boundary so call sites only emit message names + extras.
          yield* Effect.annotateLogsScoped({
            issue_id: issueId,
            issue_display_id: displayId,
            attempt,
          });
          // Register the running-set release finalizer FIRST so it runs LAST
          // on scope exit (LIFO) — guarantees the slot frees regardless of
          // outcome (success, failure, interrupt). Spec line 327 invariant.
          yield* Effect.addFinalizer(() => releaseEffect(issueId)(ref));
          // Step 3: claim into running set. Failure here is AlreadyClaimedError
          // — the issue was already in flight (state-ts invariant). The
          // finalizer above is a no-op for a slot we never owned.
          yield* claimEffect({
            issueId,
            displayId,
            attempt,
            claimedAt: new Date(),
          })(ref);

          // Step 4: claim in fp (status + symphony_state) + record attempt.
          // Two-call cadence is acceptable per §7 open-prompts decision.
          yield* writeFp(fp.claimIssue(issueId), issueId, "claimIssue");
          yield* writeFp(fp.setAttempt(issueId, attempt), issueId, "setAttempt");
          yield* Effect.logInfo("claim.acquired");

          // Step 7: create sandbox. The first post-claim failure mode (F3).
          const sandboxName = (config.sandboxNameFor ?? defaultSandboxName)(issue, attempt);
          const runId = defaultRunId(issue, attempt);
          const baseLabels = {
            fp_issue_id: issueId,
            fp_display_id: displayId,
            app: "symphony",
            attempt: String(attempt),
            run_id: runId,
            created_at_ms: String(Date.now()),
          };
          const spec: DaytonaSandboxSpec = {
            name: sandboxName,
            snapshotName: config.snapshotName,
            language: "typescript",
            labels: (config.sandboxLabelsFor ?? ((_issue, _attempt, labels) => labels))(
              issue,
              attempt,
              baseLabels,
            ),
            envVars: { CODEX_HOME: SANDBOX_CODEX_HOME },
            autoStopInterval: config.autoStopInterval,
            autoDeleteInterval: config.autoDeleteInterval,
          };
          const handle: SandboxHandle = yield* daytona.createSandbox(spec).pipe(
            Effect.mapError(
              (err) =>
                new SandboxSetupError({
                  issueId,
                  attempt,
                  stage: "create",
                  reason: err.reason,
                }),
            ),
          );
          yield* Effect.addFinalizer(() => cleanupSandboxSecrets(daytona, fp, handle, issueId));

          // Layer sandbox_id annotation onto every subsequent log emission
          // for this scope.
          yield* Effect.annotateLogsScoped({ sandbox_id: handle.id });
          yield* Effect.logInfo("sandbox.created");
          const codexAuthContent = yield* fs.readFileString(config.codexAuthHostPath).pipe(
            Effect.mapError(
              (err): SandboxSetupError =>
                new SandboxSetupError({
                  issueId,
                  attempt,
                  stage: "upload",
                  reason: err.message,
                }),
            ),
          );
          const codexAuthSecrets = yield* collectJsonStringSecrets(
            codexAuthContent,
            issueId,
            attempt,
          );
          const transcriptRedactor = makeRedactor([
            config.fpRest.token ?? "",
            config.source.githubToken ?? "",
            ...codexAuthSecrets,
          ]);

          yield* writeFp(
            fp.setRunMetadata(issueId, {
              branch: handoff.branchName,
              baseSha: handoff.baseSha,
              runId,
              sandboxId: handle.id,
            }),
            issueId,
            "setRunMetadata",
          );

          const rendered = yield* prompt
            .renderPrompt({
              issue: issue.detail,
              attempt,
              source: workerPromptSource(handoff, runId, handle.id),
            })
            .pipe(
              Effect.mapError(
                (err): SandboxSetupError =>
                  new SandboxSetupError({
                    issueId,
                    attempt,
                    stage: "render-prompt",
                    reason: "_tag" in err ? `${err._tag}` : "render failed",
                  }),
              ),
            );
          yield* Effect.addFinalizer(() =>
            fs.remove(dirname(rendered.hostPath), { recursive: true }).pipe(Effect.ignore),
          );

          const workerEnvHostPath = yield* Effect.gen(function* () {
            const dir = yield* fs.makeTempDirectory({ prefix: "swy-worker-env-" }).pipe(
              Effect.mapError(
                (err): SandboxSetupError =>
                  new SandboxSetupError({
                    issueId,
                    attempt,
                    stage: "render-worker-env",
                    reason: err.message,
                  }),
              ),
            );
            yield* Effect.addFinalizer(() =>
              fs.remove(dir, { recursive: true }).pipe(Effect.ignore),
            );
            const hostPath = `${dir}/worker-env`;
            yield* fs
              .writeFileString(
                hostPath,
                renderWorkerEnvFile(config.fpRest, config.source.githubToken, {
                  branch: handoff.branchName,
                  baseSha: handoff.baseSha,
                  runId,
                  sandboxId: handle.id,
                }),
              )
              .pipe(
                Effect.mapError(
                  (err): SandboxSetupError =>
                    new SandboxSetupError({
                      issueId,
                      attempt,
                      stage: "render-worker-env",
                      reason: err.message,
                    }),
                ),
              );
            yield* fs.chmod(hostPath, 0o600).pipe(
              Effect.mapError(
                (err): SandboxSetupError =>
                  new SandboxSetupError({
                    issueId,
                    attempt,
                    stage: "render-worker-env",
                    reason: err.message,
                  }),
              ),
            );
            return hostPath;
          });

          // First operator-facing comment (cadence #1).
          yield* writeFp(
            fp.addComment(issueId, `Dispatched to sandbox \`${handle.id}\``),
            issueId,
            "addComment(dispatched)",
          );

          // Step 9: in-sandbox setup script. Clone the remote repo, checkout
          // the pinned base SHA, and create the deterministic worker branch.
          yield* scripts
            .setupClone(handle, {
              repoUrl: handoff.repoUrl,
              baseBranch: handoff.baseBranch,
              baseSha: handoff.baseSha,
              repoPath: handoff.repoPath,
              branchName: handoff.branchName,
              symphonyDir: SANDBOX_SYMPHONY_DIR,
              githubToken: config.source.githubToken,
            })
            .pipe(
              Effect.mapError(
                (err): SandboxSetupError =>
                  new SandboxSetupError({
                    issueId,
                    attempt,
                    stage: "setup",
                    reason: "stderr" in err ? err.stderr : err.reason,
                  }),
              ),
            );

          // Upload secret-bearing files only after clone setup succeeds, so
          // setup failures cannot strand credentials in the sandbox.
          yield* prepareSandboxSecretDirs(daytona, handle);
          yield* daytona
            .uploadFiles(handle, [
              { src: rendered.hostPath, dst: rendered.sandboxPath },
              { src: config.codexAuthHostPath, dst: SANDBOX_CODEX_AUTH_PATH },
              { src: workerEnvHostPath, dst: SANDBOX_WORKER_ENV_PATH },
            ])
            .pipe(
              Effect.mapError(
                (err) =>
                  new SandboxSetupError({
                    issueId,
                    attempt,
                    stage: "upload",
                    reason: err.reason,
                  }),
              ),
            );
          yield* restrictWorkerEnv(daytona, handle);
          yield* Effect.logInfo("source.uploaded");

          // Steps 10 + 11: child scope for codex app-server session + runTurn.
          // Effect.scoped closes the codex session before post-turn fp reads.
          const turnResult = yield* Effect.scoped(
            Effect.gen(function* () {
              const daytonaStream = yield* session
                .start(handle, codexAppServerCommand(handoff.repoPath, { workerEnv: true }))
                .pipe(
                  Effect.mapError(
                    (err): SandboxSetupError =>
                      new SandboxSetupError({
                        issueId,
                        attempt,
                        stage: "session-start",
                        reason: err.reason,
                      }),
                  ),
                );
              const protocolStream = bridgeProtocolStream(daytonaStream);
              yield* Effect.logInfo("turn.started");
              const outcome = yield* runner
                .runTurn({
                  stream: protocolStream,
                  prompt: rendered.content,
                  cwd: handoff.repoPath,
                  turnTimeoutMs: config.turnTimeoutMs,
                })
                .pipe(Effect.mapError((err) => runnerErrorToProtocol(issueId, attempt, err)));
              return outcome;
            }),
          );
          yield* Effect.logInfo("turn.completed").pipe(
            Effect.annotateLogs({ worker_status: turnResult.kind }),
          );

          // Step 12: write transcript. Buffered post-completion.
          const runDir = yield* artifactStore.runDir(issueId, attempt).pipe(
            Effect.mapError(
              (err): TranscriptWriteError =>
                new TranscriptWriteError({
                  path: err.path,
                  operation: "resolve runDir",
                  reason: err.reason,
                }),
            ),
          );
          yield* writeTranscript(runDir, turnResult.events, { redact: transcriptRedactor.redact });

          // F7: non-completed TurnOutcome. The sandbox worker owns fp terminal
          // state after handoff; if it already wrote a terminal value, preserve
          // that state and only write local evidence.
          const outcomeProtocol = turnOutcomeToProtocol(issueId, attempt, turnResult);
          if (outcomeProtocol !== null) {
            const lastError = `protocol stream ${outcomeProtocol.kind}: ${truncateLastError(outcomeProtocol.reason)}`;
            const record = makeRecord({
              status: "needs-attention",
              branch: "",
              baseRev: handoff.baseSha,
              workerStatus: Option.none(),
              startedAt,
              attempt,
            });
            yield* artifactStore
              .writeRecord(issueId, attempt, record)
              .pipe(Effect.mapError(mapArtifactWriteError));
            const skipCrashPark = yield* shouldSkipGithubCloneCrashPark(fp, issueId);
            if (!skipCrashPark) {
              yield* writeFp(
                fp.markNeedsAttention(issueId, lastError),
                issueId,
                "markNeedsAttention(protocol)",
              );
            }
            yield* Effect.logWarning("failure").pipe(
              Effect.annotateLogs({
                failure_code: "F7",
                error_tag: "ProtocolStreamNonCompleted",
                reason: lastError,
                fp_write_skipped: skipCrashPark,
              }),
            );
            return resultFromError(issueId, attempt, lastError, undefined, undefined);
          }

          const verified = yield* verifyGithubCloneCompletion(fp, issueId, {
            branch: handoff.branchName,
            baseSha: handoff.baseSha,
            runId,
            sandboxId: handle.id,
          });
          if (verified.kind === "missing") {
            const record = makeRecord({
              status: "needs-attention",
              branch: handoff.branchName,
              baseRev: handoff.baseSha,
              workerStatus: Option.none(),
              startedAt,
              attempt,
              integrationError: verified.reason,
            });
            yield* artifactStore
              .writeRecord(issueId, attempt, record)
              .pipe(Effect.mapError(mapArtifactWriteError));
            const skipCrashPark = yield* shouldSkipGithubCloneCrashPark(fp, issueId);
            if (!skipCrashPark) {
              yield* writeFp(
                fp.markNeedsAttention(issueId, verified.reason),
                issueId,
                "markNeedsAttention(worker-handoff)",
              );
            }
            yield* Effect.logWarning("worker.handoff.incomplete").pipe(
              Effect.annotateLogs({
                branch: handoff.branchName,
                run_id: runId,
                sandbox_id: handle.id,
                reason: verified.reason,
                fp_write_skipped: skipCrashPark,
              }),
            );
            return {
              issueId,
              attempt,
              status: "needs-attention" as const,
              branch: handoff.branchName,
              summary: undefined,
              lastError: verified.reason,
            };
          }

          const record = makeRecord({
            status: "integrated",
            branch: verified.completion.branch,
            baseRev: verified.completion.baseSha,
            workerStatus: Option.some("completed"),
            startedAt,
            attempt,
          });
          yield* artifactStore
            .writeRecord(issueId, attempt, record)
            .pipe(Effect.mapError(mapArtifactWriteError));
          yield* Effect.logInfo("worker.handoff.completed").pipe(
            Effect.annotateLogs({
              branch: verified.completion.branch,
              run_id: verified.completion.runId,
              sandbox_id: verified.completion.sandboxId,
              pr_url: verified.completion.prUrl,
              pr_number: verified.completion.prNumber,
              head_sha: verified.completion.headSha,
            }),
          );
          return {
            issueId,
            attempt,
            status: "integrated" as const,
            branch: verified.completion.branch,
            summary: `Worker opened PR ${verified.completion.prUrl}`,
            lastError: undefined,
          };
        }).pipe(
          // Failure-matrix routing for post-claim throws (F3-F7, F9, F14).
          // Each tag maps to the prescribed `symphony_last_error` head
          // string, writes an outcome record (status=needs-attention), and
          // calls markNeedsAttention. The terminal markNeedsAttention itself
          // can fail — F15 says retry once then leave at in-progress; we
          // collapse the second failure into the returned RunOneResult so the
          // running-set finalizer still fires.
          Effect.catchTags({
            SandboxSetupError: (err) =>
              routePostClaimFailure({
                ref,
                fp,
                artifactStore,
                issueId,
                attempt,
                baseRev: handoff.baseSha,
                lastError: sandboxSetupLastError(err),
                comment: sandboxSetupLastError(err),
                startedAt,
                failureCode: sandboxStageFailureCode(err.stage),
                errorTag: err._tag,
              }),
            ProtocolStreamError: (err) =>
              Effect.gen(function* () {
                const skipFpWrite = yield* shouldSkipGithubCloneCrashPark(fp, issueId);
                return yield* routePostClaimFailure({
                  ref,
                  fp,
                  artifactStore,
                  issueId,
                  attempt,
                  baseRev: handoff.baseSha,
                  lastError: `protocol stream ${err.kind}: ${truncateLastError(err.reason)}`,
                  comment: `protocol stream ${err.kind}: ${err.reason}`,
                  startedAt,
                  failureCode: "F7",
                  errorTag: err._tag,
                  skipFpWrite,
                });
              }),
            TranscriptWriteError: (err) =>
              Effect.gen(function* () {
                const skipFpWrite = yield* shouldSkipGithubCloneCrashPark(fp, issueId);
                return yield* routePostClaimFailure({
                  ref,
                  fp,
                  artifactStore,
                  issueId,
                  attempt,
                  baseRev: handoff.baseSha,
                  lastError: `${err.operation} failed: ${truncateLastError(err.reason)}`,
                  comment: `${err.operation} failed at ${err.path}: ${err.reason}`,
                  startedAt,
                  failureCode: "F9",
                  errorTag: err._tag,
                  skipFpWrite,
                });
              }),
            // FpWriteFailedError on intermediate writes (claim, addComment,
            // setAttempt, setRunMetadata) — best-effort log + park. The slot
            // still releases via finalizer.
            FpWriteFailedError: (err) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("failure").pipe(
                  Effect.annotateLogs({
                    failure_code: "F15",
                    error_tag: err._tag,
                    operation: err.operation,
                    reason: err.reason,
                  }),
                );
                return resultFromError(
                  err.issueId,
                  attempt,
                  `fp write ${err.operation} failed: ${truncateLastError(err.reason)}`,
                  undefined,
                  undefined,
                );
              }),
          }),
        ),
      );
    }).pipe(
      Effect.withSpan("OrchestratorService.runOne", {
        attributes: {
          issue_id: issue.detail.id,
          issue_display_id: issue.detail.displayId,
        },
      }),
    );

const mapArtifactWriteError = (
  err: ArtifactPathError | ArtifactDecodeError,
): TranscriptWriteError =>
  new TranscriptWriteError({
    path: "outcome-record.json",
    operation: "write record",
    reason: artifactReadErrorReason(err),
  });

const makeRecord = (input: {
  readonly status: "integrated" | "needs-attention";
  readonly branch: string;
  readonly baseRev: string;
  readonly workerStatus: Option.Option<
    OrchestratorRecord["workerStatus"] extends Option.Option<infer A> ? A : never
  >;
  readonly startedAt: string;
  readonly attempt: number;
  readonly integrationError?: string | undefined;
}): OrchestratorRecord => ({
  status: input.status,
  branch: input.branch,
  baseRev: input.baseRev,
  workerStatus: input.workerStatus,
  ...(input.integrationError === undefined ? {} : { integrationError: input.integrationError }),
  startedAt: input.startedAt,
  endedAt: new Date().toISOString(),
  attempt: input.attempt,
});

const resultFromError = (
  issueId: string,
  attempt: number,
  lastError: string,
  branch: string | undefined,
  summary: string | undefined,
): RunOneResult => ({
  issueId,
  attempt,
  status: "needs-attention",
  branch,
  summary,
  lastError,
});

// Sandbox-step → `symphony_last_error` head string mapping per the failure
// matrix. Single source of truth so a typo in the prefix doesn't drift across
// branches.
const sandboxSetupLastError = (err: SandboxSetupError): string => {
  const stagePrefix: Record<SandboxSetupError["stage"], string> = {
    create: "sandbox create failed",
    "render-prompt": "worker prompt render failed",
    "render-worker-env": "worker env render failed",
    upload: "sandbox upload failed",
    setup: "sandbox setup failed",
    "session-start": "codex app-server start failed",
  };
  return `${stagePrefix[err.stage]}: ${truncateLastError(err.reason)}`;
};

// Shared post-claim failure router: writes the needs-attention record and
// marks the issue. Used by every Effect.catchTags branch in the runOneImpl
// scoped block. Suppresses any FpWriteFailedError on the terminal write so
// the running-set finalizer still fires (F15 deferral).
const sandboxStageFailureCode = (stage: SandboxSetupError["stage"]): string => {
  switch (stage) {
    case "create":
    case "render-prompt":
    case "render-worker-env":
    case "upload":
    case "setup":
      return "F3";
    case "session-start":
      return "F5";
  }
};

const routePostClaimFailure = (input: {
  readonly ref: Ref.Ref<RunningSet>;
  readonly fp: Context.Tag.Service<FpService>;
  readonly artifactStore: Context.Tag.Service<ArtifactStore>;
  readonly issueId: string;
  readonly attempt: number;
  readonly baseRev: string;
  readonly lastError: string;
  readonly comment: string;
  readonly startedAt: string;
  readonly failureCode: string;
  readonly errorTag: string;
  readonly skipFpWrite?: boolean | undefined;
}): Effect.Effect<RunOneResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* Effect.logWarning("failure").pipe(
      Effect.annotateLogs({
        failure_code: input.failureCode,
        error_tag: input.errorTag,
        reason: input.lastError,
      }),
    );
    const record = makeRecord({
      status: "needs-attention",
      branch: "",
      baseRev: input.baseRev,
      workerStatus: Option.none(),
      startedAt: input.startedAt,
      attempt: input.attempt,
    });
    // Best-effort record write — don't let an FS failure mask the routing.
    yield* input.artifactStore
      .writeRecord(input.issueId, input.attempt, record)
      .pipe(Effect.ignore);
    // Best-effort fp write — log and continue if it fails (F15: retry-once
    // not yet implemented; tracked for later).
    if (input.skipFpWrite !== true) {
      yield* input.fp.markNeedsAttention(input.issueId, input.comment).pipe(
        Effect.catchAll((err) =>
          Effect.logWarning("markNeedsAttention failed; issue stays at in-progress").pipe(
            Effect.annotateLogs({
              issue_id: input.issueId,
              reason: "stderr" in err ? err.stderr : err._tag,
            }),
          ),
        ),
      );
    } else {
      yield* Effect.logWarning("markNeedsAttention skipped; worker owns terminal state").pipe(
        Effect.annotateLogs({ issue_id: input.issueId }),
      );
    }
    return resultFromError(input.issueId, input.attempt, input.lastError, undefined, undefined);
  });

// Per-tick driver. Synchronous (no internal sleep) — index.ts wraps in a
// Schedule.spaced loop. Uses a closure over the shared Ref<RunningSet> so all
// ticks observe the same single-process running set.
const runOneTickImpl = (
  config: OrchestratorServiceConfig,
  ref: Ref.Ref<RunningSet>,
  fp: Context.Tag.Service<FpService>,
  runOne: (
    issue: EligibleIssue,
  ) => Effect.Effect<RunOneResult, OrchestratorError, FileSystem.FileSystem>,
): Effect.Effect<TickResult, OrchestratorError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const runningSet = yield* Ref.get(ref);
    const slots = availableSlots(runningSet, config.maxConcurrentAgents);
    yield* Effect.logInfo("tick.start").pipe(Effect.annotateLogs({ available_slots: slots }));
    if (slots <= 0) {
      // Concurrency cap reached. Don't even fetch candidates.
      return { dispatched: [], skipped: [] } satisfies TickResult;
    }
    const runningIds = new Set(runningSet.entries.keys());
    const scan = yield* fp
      .fetchCandidates(runningIds)
      .pipe(
        Effect.mapError(
          (err): DispatchError =>
            new DispatchError({ stage: "fetch-candidates", reason: err._tag }),
        ),
      );
    const verdict = select({
      scan,
      runningSet,
      maxConcurrentAgents: config.maxConcurrentAgents,
    });
    const dispatched: TickDispatch[] = [];
    const skipped: TickSkip[] = verdict.skipped.map((skip) => ({
      issueId: skip.id,
      displayId: skip.displayId,
      reason: skip.reason,
    }));
    if (verdict.toDispatch.length === 0) {
      return { dispatched, skipped } satisfies TickResult;
    }
    // v1 single-flight: only run the first dispatched issue per tick. The
    // selector already truncated to the slot budget, but we additionally cap
    // at 1 here per the explicit "one issue per tick" decision.
    const issue = verdict.toDispatch[0]!;
    yield* Effect.logInfo("candidate.selected").pipe(
      Effect.annotateLogs({
        issue_id: issue.detail.id,
        issue_display_id: issue.detail.displayId,
      }),
    );
    const dispatchOutcome = yield* runOne(issue).pipe(
      // Pre-claim failures (DispatchError, MissingCodexAuthError,
      // UnparseableAttemptError, AlreadyClaimedError) are "log + skip" per
      // §5b rule 1 — they MUST NOT kill the tick. Catch them here so the
      // tick continues to the next poll interval; the issue stays at todo
      // and will be re-evaluated.
      Effect.catchTags({
        DispatchError: (err) =>
          Effect.logWarning("dispatch failed pre-claim; skipping candidate").pipe(
            Effect.annotateLogs({
              issue_id: err.issueId ?? "",
              stage: err.stage,
              reason: err.reason,
            }),
            Effect.as(null),
          ),
        MissingCodexAuthError: (err) =>
          Effect.logError("codex auth missing; orchestrator cannot dispatch").pipe(
            Effect.annotateLogs({ path: err.path, reason: err.reason }),
            Effect.as(null),
          ),
        UnparseableAttemptError: (err) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("unparseable symphony_attempt; parking issue").pipe(
              Effect.annotateLogs({ issue_id: err.issueId, raw: err.raw }),
            );
            yield* fp
              .markNeedsAttention(err.issueId, `unparseable symphony_attempt: ${err.raw}`)
              .pipe(Effect.ignore);
            return null;
          }),
        AlreadyClaimedError: (err) =>
          Effect.logDebug("issue already claimed (race); skipping").pipe(
            Effect.annotateLogs({ issue_id: err.issueId }),
            Effect.as(null),
          ),
      }),
    );
    if (dispatchOutcome !== null) {
      dispatched.push({
        issueId: dispatchOutcome.issueId,
        displayId: issue.detail.displayId,
        attempt: dispatchOutcome.attempt,
      });
    } else {
      skipped.push({
        issueId: issue.detail.id,
        displayId: issue.detail.displayId,
        reason: "pre-claim-failure",
      });
    }
    return { dispatched, skipped };
  }).pipe(Effect.withSpan("OrchestratorService.runOneTick"));

export const OrchestratorServiceLive = (config: OrchestratorServiceConfig) =>
  Layer.effect(
    OrchestratorService,
    Effect.gen(function* () {
      const ref = yield* makeRunningSetRef;
      const fp = yield* FpService;
      const daytona = yield* DaytonaAdapter;
      const session = yield* DaytonaSession;
      const integration = yield* IntegrationService;
      const artifactStore = yield* ArtifactStore;
      const prompt = yield* WorkerPromptService;
      const scripts = yield* SandboxScriptService;
      const runner = yield* AgentRunner;
      // In-flight runOne fiber tracker. `stop` interrupts whichever runOne is
      // in flight (if any) and parks the issue at needs-attention with the
      // signal-interrupt last_error. Set on dispatch, cleared on completion.
      const inFlight = yield* Ref.make<
        Option.Option<{
          readonly issueId: string;
          readonly fiber: Fiber.RuntimeFiber<RunOneResult, OrchestratorError>;
        }>
      >(Option.none());

      const trackInFlight = <A, E extends OrchestratorError>(
        issueId: string,
        effect: Effect.Effect<A, E, FileSystem.FileSystem>,
      ): Effect.Effect<A, E, FileSystem.FileSystem> =>
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(effect);
          yield* Ref.set(
            inFlight,
            Option.some({
              issueId,
              fiber: fiber as Fiber.RuntimeFiber<RunOneResult, OrchestratorError>,
            }),
          );
          const result = yield* Fiber.join(fiber).pipe(
            Effect.ensuring(Ref.set(inFlight, Option.none())),
          );
          return result;
        });

      const runOne = (issue: EligibleIssue) =>
        trackInFlight(
          issue.detail.id,
          runOneImpl(
            config,
            ref,
            fp,
            daytona,
            session,
            integration,
            artifactStore,
            prompt,
            scripts,
            runner,
          )(issue),
        );

      // runOneTick dispatches through the tracked runOne wrapper — stop must
      // interrupt the runOne fired from inside a tick too.
      const runOneTick: Effect.Effect<TickResult, OrchestratorError, FileSystem.FileSystem> =
        runOneTickImpl(config, ref, fp, runOne);

      return {
        runOne,
        runOneTick,
        stop: Effect.gen(function* () {
          const current = yield* Ref.get(inFlight);
          if (Option.isNone(current)) {
            return;
          }
          // Interrupt the in-flight runOne fiber. Its outer scope finalizers
          // (running-set release, tempdir cleanup) fire as part of the
          // interrupt cleanup. Then mark needs-attention with the locked
          // SIGINT/SIGTERM error string.
          yield* Fiber.interrupt(current.value.fiber);
          yield* fp
            .markNeedsAttention(current.value.issueId, "orchestrator interrupted by signal")
            .pipe(Effect.ignore);
        }),
      };
    }),
  );

// Single-spot extractor for the "human-readable reason" inside an
// ArtifactPathError vs ArtifactDecodeError. Lives outside the pipeline so the
// no-manual-tag-check rule sees the discriminant in one place.
const artifactReadErrorReason = (err: ArtifactPathError | ArtifactDecodeError): string => {
  switch (err._tag) {
    case "ArtifactDecodeError":
      return err.details;
    case "ArtifactPathError":
      return err.reason;
  }
};

// Map any FpService write into a uniform FpWriteFailedError so the runOne
// effect channel stays inside OrchestratorError.
const writeFp = <A>(
  effect: Effect.Effect<A, WriteError>,
  issueId: string,
  operation: string,
): Effect.Effect<A, FpWriteFailedError> =>
  effect.pipe(
    Effect.mapError(
      (err) =>
        new FpWriteFailedError({
          issueId,
          operation,
          reason: "stderr" in err ? err.stderr : err._tag,
        }),
    ),
  );
