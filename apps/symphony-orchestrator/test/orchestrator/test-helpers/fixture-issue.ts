import type { EligibleIssue } from "../../../src/fp/eligibility.js";
import type { FpIssueDetail } from "../../../src/fp/models.js";
import type { SymphonyProperties } from "../../../src/fp/symphony-properties.js";

export const fixtureIssueDetail = (
  id = "abc123",
  overrides: Partial<FpIssueDetail> = {},
): FpIssueDetail => ({
  id,
  displayId: `SWY-${id}`,
  title: "fixture issue",
  description: "fixture body",
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
  ...overrides,
});

const fixtureProperties = (overrides: Partial<SymphonyProperties> = {}): SymphonyProperties => ({
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
  ...overrides,
});

export const fixtureEligible = (
  id = "abc123",
  overrides: { detail?: Partial<FpIssueDetail>; properties?: Partial<SymphonyProperties> } = {},
): EligibleIssue => ({
  detail: fixtureIssueDetail(id, overrides.detail ?? {}),
  properties: fixtureProperties(overrides.properties ?? {}),
});
