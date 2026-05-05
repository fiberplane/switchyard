import type { EligibleIssue } from "../fp/eligibility.js";
import type { CandidateRejection, CandidateScan } from "../fp/service.js";
import { availableSlots, type RunningSet } from "./state.js";

export type SelectorSkipReason = CandidateRejection["reason"] | "slot-cap";

export type SelectorSkip = {
  readonly id: string;
  readonly displayId: string;
  readonly reason: SelectorSkipReason;
};

export type SelectorVerdict = {
  readonly toDispatch: ReadonlyArray<EligibleIssue>;
  readonly skipped: ReadonlyArray<SelectorSkip>;
};

export type SelectorInput = {
  readonly scan: CandidateScan;
  readonly runningSet: RunningSet;
  readonly maxConcurrentAgents: number;
};

export const select = ({
  scan,
  runningSet,
  maxConcurrentAgents,
}: SelectorInput): SelectorVerdict => {
  const slots = availableSlots(runningSet, maxConcurrentAgents);
  const toDispatch = scan.eligible.slice(0, slots);

  const overflowSkips: ReadonlyArray<SelectorSkip> = scan.eligible.slice(slots).map((issue) => ({
    id: issue.detail.id,
    displayId: issue.detail.displayId,
    reason: "slot-cap",
  }));
  const rejectionSkips: ReadonlyArray<SelectorSkip> = scan.rejected.map((rejection) => ({
    id: rejection.id,
    displayId: rejection.displayId,
    reason: rejection.reason,
  }));

  return {
    toDispatch,
    skipped: [...overflowSkips, ...rejectionSkips],
  };
};
