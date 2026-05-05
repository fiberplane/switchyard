import { Context, Effect, Either, Layer } from "effect";

import { FpAdapter } from "./adapter.js";
import {
  buildOpenIssueIndex,
  type EligibleIssue,
  type IneligibilityReason,
  isEligible,
} from "./eligibility.js";
import type { FpBinaryNotFoundError, FpCommandError, FpDecodeError } from "./errors.js";
import { decodeSymphonyProperties } from "./symphony-properties.js";

export type FetchCandidatesError = FpBinaryNotFoundError | FpCommandError | FpDecodeError;
export type WriteError = FpBinaryNotFoundError | FpCommandError;

export type CandidateRejection = {
  readonly id: string;
  readonly displayId: string;
  readonly reason: IneligibilityReason;
};

export type CandidateScan = {
  readonly eligible: ReadonlyArray<EligibleIssue>;
  readonly rejected: ReadonlyArray<CandidateRejection>;
};

export type FpServiceShape = {
  readonly fetchCandidates: (
    runningSet: ReadonlySet<string>,
  ) => Effect.Effect<CandidateScan, FetchCandidatesError>;
  readonly claimIssue: (id: string) => Effect.Effect<void, WriteError>;
  readonly markCompleted: (id: string, summary: string) => Effect.Effect<void, WriteError>;
  readonly markNeedsAttention: (id: string, error: string) => Effect.Effect<void, WriteError>;
  readonly setAttempt: (id: string, attempt: number) => Effect.Effect<void, WriteError>;
  readonly setArtifact: (id: string, path: string) => Effect.Effect<void, WriteError>;
  // Pure comment write — no status / property change. The orchestrator's
  // three-comment cadence ("Dispatched to sandbox <id>", "Worker turn
  // completed; integrating", final summary) uses this for the first two; the
  // third coalesces with markCompleted/markNeedsAttention.
  readonly addComment: (id: string, body: string) => Effect.Effect<void, WriteError>;
};

export class FpService extends Context.Tag("FpService")<FpService, FpServiceShape>() {}

export const FpServiceLive = Layer.effect(
  FpService,
  Effect.gen(function* () {
    const adapter = yield* FpAdapter;

    return {
      // N+1 fetch is the expected v1 behavior. Optimization (an `fp issue list` flag that
      // returns properties inline) is tracked by SWYRD-jmxexmkw — see docs/architecture/fp-boundary.md.
      fetchCandidates: (runningSet) =>
        Effect.gen(function* () {
          const [todoIssues, inProgressIssues] = yield* Effect.all(
            [adapter.listIssuesByStatus("todo"), adapter.listIssuesByStatus("in-progress")],
            { concurrency: "unbounded" },
          );
          const openIssues = buildOpenIssueIndex([...todoIssues, ...inProgressIssues]);

          const eligible: EligibleIssue[] = [];
          const rejected: CandidateRejection[] = [];

          for (const candidate of todoIssues) {
            const detail = yield* adapter.showIssue(candidate.id);
            const decoded = decodeSymphonyProperties(detail.properties);
            if (Either.isLeft(decoded)) {
              yield* Effect.logWarning("symphony properties failed to decode").pipe(
                Effect.annotateLogs({
                  issue_display_id: detail.displayId,
                  issue_id: detail.id,
                  reason: decoded.left,
                }),
              );
              rejected.push({
                id: detail.id,
                displayId: detail.displayId,
                reason: "malformed-symphony-properties",
              });
              continue;
            }
            const verdict = isEligible(detail, decoded.right, openIssues, runningSet);
            if (Either.isLeft(verdict)) {
              rejected.push({
                id: detail.id,
                displayId: detail.displayId,
                reason: verdict.left,
              });
              continue;
            }
            eligible.push(verdict.right);
          }

          return { eligible, rejected };
        }),
      claimIssue: (id) =>
        adapter.updateIssue(id, {
          status: "in-progress",
          properties: { symphony_state: "active" },
        }),
      markCompleted: (id, summary) =>
        adapter.updateIssue(id, {
          status: "done",
          properties: { symphony_state: "end" },
          comment: summary,
        }),
      markNeedsAttention: (id, error) =>
        adapter.updateIssue(id, {
          properties: { symphony_state: "needs-attention", symphony_last_error: error },
          comment: error,
        }),
      setAttempt: (id, attempt) =>
        adapter.updateIssue(id, {
          properties: { symphony_attempt: String(attempt) },
        }),
      setArtifact: (id, path) =>
        adapter.updateIssue(id, {
          properties: { symphony_artifact: path },
        }),
      addComment: (id, body) => adapter.addComment(id, body),
    };
  }),
);
