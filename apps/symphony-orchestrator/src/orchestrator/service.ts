// Orchestrator runOne pipeline + per-tick poll. The per-issue lifecycle
// integrator that ties every other module into a working driver. The 20-step
// pipeline ordering, failure-matrix routing, and three-comment cadence are
// load-bearing; see docs/architecture/orchestrator-runone.md (drift-bound).

import { dirname } from "node:path";

import { Error as PlatformError, FileSystem } from "@effect/platform";
import { Context, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";

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
import type { WriteError } from "../fp/service.js";
import type { IntegrationResult } from "../integration/models.js";
import { IntegrationService } from "../integration/service.js";
import { WorkerPromptService } from "../prompt/service.js";
import { ProtocolRecvError, ProtocolSendError } from "../runner/errors.js";
import { AgentRunner, type RunnerError, type TurnOutcome } from "../runner/service.js";
import type { ProtocolStream } from "../runner/transport.js";
import {
  SANDBOX_ARCHIVE_PATH,
  SANDBOX_BUNDLE_PATH,
  SANDBOX_REPO_PATH,
  SANDBOX_SYMPHONY_DIR,
} from "../sandbox-scripts/models.js";
import { SandboxScriptService } from "../sandbox-scripts/service.js";
import {
  DispatchError,
  FpWriteFailedError,
  IntegrationFailedError,
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

// In-sandbox path the v1 demo copies host `~/.codex/auth.json` into.
// `daytona.createSandbox` then sets `CODEX_HOME` to the parent dir so codex
// picks up the auth on app-server start. Locked path; productionized API-key
// path is deferred to SWYRD-jbzbqkon.
const SANDBOX_CODEX_HOME = "/tmp";
const SANDBOX_CODEX_AUTH_PATH = `${SANDBOX_CODEX_HOME}/auth.json`;

// `cd ${SANDBOX_REPO_PATH} && codex app-server` — NOT `exec codex app-server`.
// `exec` replaces the wrapper bash and defeats DaytonaSession's EXIT-trap
// workaround (daytona.session.ts:386-394), producing a false SIGKILL detection
// on clean codex exit. Locked in §7.
const CODEX_APP_SERVER_COMMAND = `cd ${SANDBOX_REPO_PATH} && codex app-server`;

// Truncate the worker's `summary` for the `summary head` portion of
// `symphony_last_error`, but never wrap or rephrase the user-facing comment
// body (that is pass-through verbatim — locked in §7).
const summaryHead = (summary: string): string => truncateLastError(summary);

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
  // Host path to the codex auth.json that gets copied into the sandbox at
  // /workspace/codex-home/auth.json. Resolved by index.ts via env →
  // ~/.codex/auth.json. Pre-claim missing → MissingCodexAuthError → log + skip.
  readonly codexAuthHostPath: string;
  // Optional sandbox-name template. Defaults to `swy-<displayId>-<attempt>`.
  readonly sandboxNameFor?: (issue: EligibleIssue, attempt: number) => string;
};

export type RunOneResult = {
  readonly issueId: string;
  readonly attempt: number;
  readonly status: "integrated" | "needs-attention";
  // Branch is present whenever a bundle was integrated (including F12 worker
  // non-completed-with-commits which keeps the plain `symphony/<id>` name).
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

// Run a single dispatched issue end-to-end through the 20-step §5b pipeline.
// Outer scope owns: state-claim release finalizer, prompt-tempdir cleanup,
// archive-tempdir cleanup. Inner Effect.scoped(runTurn) owns: codex app-server
// session lifetime — closes BEFORE the finalize bundle script runs in a
// separate session. See orchestrator-runone.md.
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
      const handoff = yield* integration
        .prepareSourceHandoff()
        .pipe(
          Effect.mapError(
            (err) => new DispatchError({ stage: "prepare-source", issueId, reason: err.stderr }),
          ),
        );

      // Step 6: render prompt. Same pre-claim rule.
      const rendered = yield* prompt.renderPrompt({ issue: issue.detail, attempt }).pipe(
        Effect.mapError(
          (err) =>
            new DispatchError({
              stage: "render-prompt",
              issueId,
              reason: "_tag" in err ? `${err._tag}` : "render failed",
            }),
        ),
      );

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
      // with SandboxSetupError / IntegrationFailedError / TranscriptWriteError
      // / FpWriteFailedError. Those tags get caught at the bottom of this
      // scoped block and routed to the prescribed markNeedsAttention write
      // before being absorbed into a `needs-attention` RunOneResult — so the
      // fp issue is NEVER left at status=in-progress without a last_error.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          // Register the running-set release finalizer FIRST so it runs LAST
          // on scope exit (LIFO) — guarantees the slot frees regardless of
          // outcome (success, failure, interrupt). Spec line 327 invariant.
          yield* Effect.addFinalizer(() => releaseEffect(issueId)(ref));
          // Tempdir cleanup finalizers (the prompt + source archive parent
          // directories — see prompt/models.ts and integration/service.ts:
          // both producers create per-render tempdirs and the contract is
          // "caller removes dirname(...)" not just the file).
          yield* Effect.addFinalizer(() =>
            fs.remove(dirname(rendered.hostPath), { recursive: true }).pipe(Effect.ignore),
          );
          yield* Effect.addFinalizer(() =>
            fs.remove(dirname(handoff.archivePath), { recursive: true }).pipe(Effect.ignore),
          );

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

          // Step 7: create sandbox. The first post-claim failure mode (F3).
          const sandboxName = (config.sandboxNameFor ?? defaultSandboxName)(issue, attempt);
          const spec: DaytonaSandboxSpec = {
            name: sandboxName,
            snapshotName: config.snapshotName,
            language: "typescript",
            labels: {
              fp_issue_id: issueId,
              app: "symphony",
              attempt: String(attempt),
            },
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

          // First operator-facing comment (cadence #1).
          yield* writeFp(
            fp.addComment(issueId, `Dispatched to sandbox \`${handle.id}\``),
            issueId,
            "addComment(dispatched)",
          );

          // Step 8: single batched upload (archive + prompt + codex auth).
          yield* daytona
            .uploadFiles(handle, [
              { src: handoff.archivePath, dst: SANDBOX_ARCHIVE_PATH },
              { src: rendered.hostPath, dst: rendered.sandboxPath },
              { src: config.codexAuthHostPath, dst: SANDBOX_CODEX_AUTH_PATH },
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

          // Step 9: in-sandbox setup script (mkdir, untar, git init/add/commit/tag).
          yield* scripts
            .setupRepo(handle, {
              archivePath: SANDBOX_ARCHIVE_PATH,
              repoPath: SANDBOX_REPO_PATH,
              symphonyDir: SANDBOX_SYMPHONY_DIR,
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

          // Steps 10 + 11: child scope for codex app-server session + runTurn.
          // Effect.scoped closes the codex session BEFORE the parent scope
          // proceeds to step 13 (finalize) — which runs in a separate
          // executeCommand session. Load-bearing per §5b clarification #3.
          const turnResult = yield* Effect.scoped(
            Effect.gen(function* () {
              const daytonaStream = yield* session.start(handle, CODEX_APP_SERVER_COMMAND).pipe(
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
              const outcome = yield* runner
                .runTurn({
                  stream: protocolStream,
                  prompt: rendered.content,
                  cwd: SANDBOX_REPO_PATH,
                  turnTimeoutMs: config.turnTimeoutMs,
                })
                .pipe(Effect.mapError((err) => runnerErrorToProtocol(issueId, attempt, err)));
              return outcome;
            }),
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
          yield* writeTranscript(runDir, turnResult.events);

          // F7: non-completed TurnOutcome. Best-effort finalize + download for
          // forensics, then surface needs-attention. We swallow finalize/
          // download errors here so the original protocol-stream error stays
          // the lastError on the issue (F7's salvage is *additive* — it tries
          // to grab forensic artifacts; the issue is already lost).
          const outcomeProtocol = turnOutcomeToProtocol(issueId, attempt, turnResult);
          if (outcomeProtocol !== null) {
            yield* salvageBundle({
              handle,
              runDir,
              scripts,
              daytona,
            }).pipe(Effect.ignore);
            const lastError = `protocol stream ${outcomeProtocol.kind}: ${truncateLastError(outcomeProtocol.reason)}`;
            const record = makeRecord({
              status: "needs-attention",
              branch: "",
              baseRev: handoff.baseRev,
              workerStatus: Option.none(),
              startedAt,
              attempt,
            });
            yield* artifactStore
              .writeRecord(issueId, attempt, record)
              .pipe(Effect.mapError(mapArtifactWriteError));
            yield* writeFp(
              fp.markNeedsAttention(issueId, lastError),
              issueId,
              "markNeedsAttention(protocol)",
            );
            return resultFromError(issueId, attempt, lastError, undefined, undefined);
          }

          // Step 13: finalize the bundle inside the sandbox (separate session).
          const bundle = yield* scripts
            .finalizeBundle(handle, {
              repoPath: SANDBOX_REPO_PATH,
              bundlePath: SANDBOX_BUNDLE_PATH,
            })
            .pipe(
              Effect.mapError(
                (err): SandboxSetupError =>
                  new SandboxSetupError({
                    issueId,
                    attempt,
                    stage: "finalize",
                    reason: "stderr" in err ? err.stderr : err.reason,
                  }),
              ),
            );

          // Step 14: download bundle + outcome.json.
          yield* daytona
            .downloadFiles(handle, [
              { src: bundle.bundlePath, dst: `${runDir}/work.bundle` },
              { src: `${SANDBOX_SYMPHONY_DIR}/outcome.json`, dst: `${runDir}/outcome.json` },
            ])
            .pipe(
              Effect.mapError(
                (err) =>
                  new SandboxSetupError({
                    issueId,
                    attempt,
                    stage: "download",
                    reason: err.reason,
                  }),
              ),
            );

          // Step 15: decode worker outcome envelope. F10: missing/malformed
          // routes to needs-attention with `malformed worker outcome`.
          const decoded = yield* artifactStore.readOutcome(issueId, attempt).pipe(
            Effect.matchEffect({
              onSuccess: (outcome) => Effect.succeed({ kind: "ok" as const, outcome }),
              onFailure: (err) =>
                Effect.succeed({
                  kind: "malformed" as const,
                  reason: artifactReadErrorReason(err),
                }),
            }),
          );

          // F11: empty bundle (commitsBeyondBase=0). Skip integration; route
          // to needs-attention with the locked error string.
          if (bundle.commitsBeyondBase === 0) {
            const lastError =
              decoded.kind === "ok" && decoded.outcome.status === "completed"
                ? "completed status with no commits"
                : "worker produced no commits";
            const record = makeRecord({
              status: "needs-attention",
              branch: "",
              baseRev: handoff.baseRev,
              workerStatus:
                decoded.kind === "ok" ? Option.some(decoded.outcome.status) : Option.none(),
              startedAt,
              attempt,
            });
            yield* artifactStore
              .writeRecord(issueId, attempt, record)
              .pipe(Effect.mapError(mapArtifactWriteError));
            yield* writeFp(
              fp.markNeedsAttention(issueId, lastError),
              issueId,
              "markNeedsAttention(empty)",
            );
            return resultFromError(issueId, attempt, lastError, undefined, undefined);
          }

          // F10: malformed outcome — integrate forensic branch (plain name
          // per locked decision; no `-incomplete` suffix).
          if (decoded.kind === "malformed") {
            const integrated = yield* integration
              .integrateBundle(`${runDir}/work.bundle`, issueId)
              .pipe(
                Effect.mapError(
                  (err): IntegrationFailedError =>
                    new IntegrationFailedError({
                      issueId,
                      attempt,
                      reason: "stderr" in err ? err.stderr : "integration failed",
                    }),
                ),
              );
            const record = makeRecord({
              status: "needs-attention",
              branch: integrated.branch,
              baseRev: handoff.baseRev,
              workerStatus: Option.none(),
              startedAt,
              attempt,
              integrationError: undefined,
            });
            yield* artifactStore
              .writeRecord(issueId, attempt, record)
              .pipe(Effect.mapError(mapArtifactWriteError));
            yield* writeFp(
              fp.markNeedsAttention(issueId, "malformed worker outcome"),
              issueId,
              "markNeedsAttention(malformed)",
            );
            return resultFromError(
              issueId,
              attempt,
              "malformed worker outcome",
              integrated.branch,
              undefined,
            );
          }

          // We have a decoded outcome AND a non-empty bundle. Cadence #2.
          yield* writeFp(
            fp.addComment(issueId, "Worker turn completed; integrating"),
            issueId,
            "addComment(integrating)",
          );

          // Step 16: integrate bundle. F13 routes failure to needs-attention.
          const integrated: IntegrationResult = yield* integration
            .integrateBundle(`${runDir}/work.bundle`, issueId)
            .pipe(
              Effect.mapError(
                (err): IntegrationFailedError =>
                  new IntegrationFailedError({
                    issueId,
                    attempt,
                    reason: "stderr" in err ? err.stderr : "integration failed",
                  }),
              ),
            );

          // F12: worker non-completed status with commits — plain branch name
          // already created via integrate; route to needs-attention with
          // `<status>: <summary head>`.
          if (decoded.outcome.status !== "completed") {
            const lastError = `${decoded.outcome.status}: ${summaryHead(decoded.outcome.summary)}`;
            const record = makeRecord({
              status: "needs-attention",
              branch: integrated.branch,
              baseRev: handoff.baseRev,
              workerStatus: Option.some(decoded.outcome.status),
              startedAt,
              attempt,
              integrationError: undefined,
            });
            yield* artifactStore
              .writeRecord(issueId, attempt, record)
              .pipe(Effect.mapError(mapArtifactWriteError));
            yield* writeFp(
              fp.markNeedsAttention(issueId, decoded.outcome.summary),
              issueId,
              "markNeedsAttention(non-completed)",
            );
            return resultFromError(
              issueId,
              attempt,
              lastError,
              integrated.branch,
              decoded.outcome.summary,
            );
          }

          // Happy path. Write record, mark completed, set artifact, cadence #3
          // is the final summary inline in markCompleted.
          const record = makeRecord({
            status: "integrated",
            branch: integrated.branch,
            baseRev: handoff.baseRev,
            workerStatus: Option.some(decoded.outcome.status),
            startedAt,
            attempt,
            integrationError: undefined,
          });
          yield* artifactStore
            .writeRecord(issueId, attempt, record)
            .pipe(Effect.mapError(mapArtifactWriteError));
          yield* writeFp(fp.setArtifact(issueId, integrated.branch), issueId, "setArtifact");
          yield* writeFp(
            fp.markCompleted(issueId, decoded.outcome.summary),
            issueId,
            "markCompleted",
          );
          return {
            issueId,
            attempt,
            status: "integrated" as const,
            branch: integrated.branch,
            summary: decoded.outcome.summary,
            lastError: undefined,
          };
        }).pipe(
          // Failure-matrix routing for post-claim throws (F3-F6, F8, F9, F13,
          // F14). Each tag maps to the prescribed `symphony_last_error` head
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
                baseRev: handoff.baseRev,
                lastError: sandboxSetupLastError(err),
                comment: sandboxSetupLastError(err),
                startedAt,
              }),
            ProtocolStreamError: (err) =>
              routePostClaimFailure({
                ref,
                fp,
                artifactStore,
                issueId,
                attempt,
                baseRev: handoff.baseRev,
                lastError: `protocol stream ${err.kind}: ${truncateLastError(err.reason)}`,
                comment: `protocol stream ${err.kind}: ${err.reason}`,
                startedAt,
              }),
            IntegrationFailedError: (err) =>
              routePostClaimFailure({
                ref,
                fp,
                artifactStore,
                issueId,
                attempt,
                baseRev: handoff.baseRev,
                lastError: `bundle integration failed: ${truncateLastError(err.reason)}`,
                comment: `bundle integration failed: ${err.reason}`,
                startedAt,
              }),
            TranscriptWriteError: (err) =>
              routePostClaimFailure({
                ref,
                fp,
                artifactStore,
                issueId,
                attempt,
                baseRev: handoff.baseRev,
                lastError: `${err.operation} failed: ${truncateLastError(err.reason)}`,
                comment: `${err.operation} failed at ${err.path}: ${err.reason}`,
                startedAt,
              }),
            // FpWriteFailedError on intermediate writes (claim, addComment,
            // setAttempt, setArtifact) — best-effort log + park. The slot
            // still releases via finalizer.
            FpWriteFailedError: (err) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("fp write failed; leaving issue at in-progress").pipe(
                  Effect.annotateLogs({
                    issue_id: err.issueId,
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

// Best-effort F7 salvage: try to finalize the in-sandbox bundle and download
// it for forensics. Errors here are intentionally absorbed by the caller
// (Effect.ignore at the call site) so the original ProtocolStreamError stays
// the lastError on the issue. The bundle, if it lands, sits at runDir/work.bundle
// for human inspection — we deliberately do NOT integrate it (per the F7 row).
const salvageBundle = (ctx: {
  readonly handle: SandboxHandle;
  readonly runDir: string;
  readonly scripts: Context.Tag.Service<SandboxScriptService>;
  readonly daytona: Context.Tag.Service<DaytonaAdapter>;
}): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const bundle = yield* ctx.scripts.finalizeBundle(ctx.handle, {
      repoPath: SANDBOX_REPO_PATH,
      bundlePath: SANDBOX_BUNDLE_PATH,
    });
    yield* ctx.daytona.downloadFiles(ctx.handle, [
      { src: bundle.bundlePath, dst: `${ctx.runDir}/work.bundle` },
      {
        src: `${SANDBOX_SYMPHONY_DIR}/outcome.json`,
        dst: `${ctx.runDir}/outcome.json`,
      },
    ]);
  }).pipe(Effect.ignore);

// Sandbox-step → `symphony_last_error` head string mapping per the failure
// matrix. Single source of truth so a typo in the prefix doesn't drift across
// branches.
const sandboxSetupLastError = (err: SandboxSetupError): string => {
  const stagePrefix: Record<SandboxSetupError["stage"], string> = {
    create: "sandbox create failed",
    upload: "sandbox upload failed",
    setup: "sandbox setup failed",
    "session-start": "codex app-server start failed",
    finalize: "bundle finalize failed",
    download: "artifact download failed",
  };
  return `${stagePrefix[err.stage]}: ${truncateLastError(err.reason)}`;
};

// Shared post-claim failure router: writes the needs-attention record and
// marks the issue. Used by every Effect.catchTags branch in the runOneImpl
// scoped block. Suppresses any FpWriteFailedError on the terminal write so
// the running-set finalizer still fires (F15 deferral).
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
}): Effect.Effect<RunOneResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
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
    if (availableSlots(runningSet, config.maxConcurrentAgents) <= 0) {
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
