import { Either } from "effect";

import type { FpIssue, FpIssueDetail } from "./models.js";
import type { SymphonyProperties } from "./symphony-properties.js";

export type IneligibilityReason =
  | "not-ready"
  | "not-todo"
  | "blocked-by-dependency"
  | "blocked-by-open-child"
  | "already-running"
  | "needs-attention-not-rearmed"
  | "malformed-symphony-properties";

export type EligibleIssue = {
  readonly detail: FpIssueDetail;
  readonly properties: SymphonyProperties;
};

export type OpenIssueIndex = {
  readonly ids: ReadonlySet<string>;
  readonly childrenByParent: ReadonlyMap<string, ReadonlyArray<string>>;
};

export const buildOpenIssueIndex = (issues: ReadonlyArray<FpIssue>): OpenIssueIndex => {
  const ids = new Set<string>();
  const childrenByParent = new Map<string, string[]>();

  for (const issue of issues) {
    ids.add(issue.id);
    if (issue.parent !== null) {
      const existing = childrenByParent.get(issue.parent);
      if (existing === undefined) {
        childrenByParent.set(issue.parent, [issue.id]);
      } else {
        existing.push(issue.id);
      }
    }
  }

  return { ids, childrenByParent };
};

export const isEligible = (
  detail: FpIssueDetail,
  properties: SymphonyProperties,
  openIssues: OpenIssueIndex,
  runningSet: ReadonlySet<string>,
): Either.Either<EligibleIssue, IneligibilityReason> => {
  if (detail.status !== "todo") {
    if (properties.symphony_state === "needs-attention") {
      return Either.left("needs-attention-not-rearmed");
    }
    return Either.left("not-todo");
  }

  if (properties.symphony_ready !== "true") {
    return Either.left("not-ready");
  }

  for (const dep of detail.dependencies) {
    if (openIssues.ids.has(dep)) {
      return Either.left("blocked-by-dependency");
    }
  }

  const openChildren = openIssues.childrenByParent.get(detail.id);
  if (openChildren !== undefined && openChildren.length > 0) {
    return Either.left("blocked-by-open-child");
  }

  if (runningSet.has(detail.id)) {
    return Either.left("already-running");
  }

  return Either.right({ detail, properties });
};
