import { describe, expect, test } from "bun:test";

import { Either } from "effect";

import type { EligibleIssue } from "../../src/fp/eligibility.js";
import type { FpIssueDetail } from "../../src/fp/models.js";
import type { CandidateScan } from "../../src/fp/service.js";
import type { SymphonyProperties } from "../../src/fp/symphony-properties.js";
import { select } from "../../src/orchestrator/selector.js";
import { claim, emptyRunningSet, type RunningEntry } from "../../src/orchestrator/state.js";

const emptyScan: CandidateScan = {
  eligible: [],
  rejected: [],
};

const detail = (id: string): FpIssueDetail => ({
  id,
  displayId: `SWY-${id}`,
  title: "fixture",
  status: "todo",
  priority: null,
  parent: null,
  dependencies: [],
  revisions: [],
  author: "test",
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:00.000Z",
  properties: {},
  comments: [],
});

const properties: SymphonyProperties = {
  symphony_state: "idle",
  symphony_ready: "true",
  symphony_attempt: undefined,
  symphony_branch: undefined,
  symphony_pr_url: undefined,
  symphony_pr_number: undefined,
  symphony_base_sha: undefined,
  symphony_head_sha: undefined,
  symphony_run_id: undefined,
  symphony_sandbox_id: undefined,
  symphony_last_error: undefined,
};

const eligible = (id: string): EligibleIssue => ({
  detail: detail(id),
  properties,
});

const claimed = (issueId: string): RunningEntry => ({
  issueId,
  displayId: `SWY-${issueId}`,
  attempt: 1,
  claimedAt: new Date("2026-05-05T00:00:00.000Z"),
});

const expectRight = <A, E>(result: Either.Either<A, E>): A => {
  if (Either.isLeft(result)) {
    throw result.left;
  }
  return result.right;
};

describe("orchestrator selector", () => {
  test("returns an empty verdict when there is nothing to dispatch", () => {
    const verdict = select({
      scan: emptyScan,
      runningSet: emptyRunningSet,
      maxConcurrentAgents: 1,
    });

    expect(verdict.toDispatch).toEqual([]);
    expect(verdict.skipped).toEqual([]);
  });

  test("dispatches a single eligible candidate when a slot is open", () => {
    const candidate = eligible("a");

    const verdict = select({
      scan: { eligible: [candidate], rejected: [] },
      runningSet: emptyRunningSet,
      maxConcurrentAgents: 1,
    });

    expect(verdict.toDispatch).toEqual([candidate]);
    expect(verdict.skipped).toEqual([]);
  });

  test("truncates eligible candidates past the slot cap and tags the overflow", () => {
    const candidates = [eligible("a"), eligible("b"), eligible("c")];

    const verdict = select({
      scan: { eligible: candidates, rejected: [] },
      runningSet: emptyRunningSet,
      maxConcurrentAgents: 1,
    });

    expect(verdict.toDispatch).toEqual([candidates[0]!]);
    expect(verdict.skipped).toEqual([
      { id: "b", displayId: "SWY-b", reason: "slot-cap" },
      { id: "c", displayId: "SWY-c", reason: "slot-cap" },
    ]);
  });

  test("subtracts the running set size from the slot budget", () => {
    const candidates = [eligible("a"), eligible("b")];
    const occupied = expectRight(claim(emptyRunningSet, claimed("z")));

    const verdict = select({
      scan: { eligible: candidates, rejected: [] },
      runningSet: occupied,
      maxConcurrentAgents: 2,
    });

    expect(verdict.toDispatch).toEqual([candidates[0]!]);
    expect(verdict.skipped).toEqual([{ id: "b", displayId: "SWY-b", reason: "slot-cap" }]);
  });

  test("passes fp rejections through to skipped without rewriting the reason", () => {
    const verdict = select({
      scan: {
        eligible: [],
        rejected: [{ id: "a", displayId: "SWY-a", reason: "not-ready" }],
      },
      runningSet: emptyRunningSet,
      maxConcurrentAgents: 1,
    });

    expect(verdict.toDispatch).toEqual([]);
    expect(verdict.skipped).toEqual([{ id: "a", displayId: "SWY-a", reason: "not-ready" }]);
  });
});
