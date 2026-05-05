import { describe, expect, test } from "bun:test";

import { Either } from "effect";

import { buildOpenIssueIndex, isEligible, type OpenIssueIndex } from "../../src/fp/eligibility.js";
import type { FpIssueDetail } from "../../src/fp/models.js";
import {
  SYMPHONY_PROPERTIES_DEFAULTS,
  type SymphonyProperties,
} from "../../src/fp/symphony-properties.js";

const issueDetail = (overrides: Partial<FpIssueDetail> = {}): FpIssueDetail => ({
  id: "issue-id-self",
  displayId: "SWY-self",
  title: "candidate",
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

const props = (overrides: Partial<SymphonyProperties> = {}): SymphonyProperties => ({
  ...SYMPHONY_PROPERTIES_DEFAULTS,
  ...overrides,
});

const emptyIndex: OpenIssueIndex = {
  ids: new Set(),
  childrenByParent: new Map(),
};

const emptyRunning: ReadonlySet<string> = new Set();

describe("isEligible — gating gates", () => {
  test("not-ready (idle, symphony_ready=false)", () => {
    const result = isEligible(
      issueDetail(),
      props({ symphony_state: "idle", symphony_ready: "false" }),
      emptyIndex,
      emptyRunning,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("not-ready");
    }
  });

  test("not-ready also fires when symphony_state=needs-attention but ready=false (row 1 'any state' axis)", () => {
    const result = isEligible(
      issueDetail(),
      props({ symphony_state: "needs-attention", symphony_ready: "false" }),
      emptyIndex,
      emptyRunning,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("not-ready");
    }
  });

  test("happy path: todo + ready + no blockers, not running → Right(EligibleIssue)", () => {
    const detail = issueDetail();
    const properties = props({ symphony_ready: "true" });
    const result = isEligible(detail, properties, emptyIndex, emptyRunning);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.detail).toBe(detail);
      expect(result.right.properties).toBe(properties);
    }
  });
});

describe("isEligible — dep / child blockers", () => {
  test("blocked-by-dependency when a dep id is present in openIssues.ids", () => {
    const dep = "dep-id-open";
    const result = isEligible(
      issueDetail({ dependencies: [dep] }),
      props({ symphony_ready: "true" }),
      { ids: new Set([dep]), childrenByParent: new Map() },
      emptyRunning,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("blocked-by-dependency");
    }
  });

  test("not blocked when all deps are absent from openIssues.ids (terminal)", () => {
    const result = isEligible(
      issueDetail({ dependencies: ["already-done-dep"] }),
      props({ symphony_ready: "true" }),
      emptyIndex,
      emptyRunning,
    );

    expect(Either.isRight(result)).toBe(true);
  });

  test("blocked-by-open-child when openIssues.childrenByParent contains this issue's id", () => {
    const detail = issueDetail({ id: "parent-id" });
    const result = isEligible(
      detail,
      props({ symphony_ready: "true" }),
      {
        ids: new Set(["open-child"]),
        childrenByParent: new Map([["parent-id", ["open-child"]]]),
      },
      emptyRunning,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("blocked-by-open-child");
    }
  });
});

describe("isEligible — running set", () => {
  test("already-running when id is in the running set", () => {
    const result = isEligible(
      issueDetail({ id: "live-issue" }),
      props({ symphony_ready: "true" }),
      emptyIndex,
      new Set(["live-issue"]),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("already-running");
    }
  });
});

describe("isEligible — needs-attention re-arm", () => {
  test("needs-attention + status=todo + ready → Right (re-armed; row 4)", () => {
    const result = isEligible(
      issueDetail({ status: "todo" }),
      props({ symphony_state: "needs-attention", symphony_ready: "true" }),
      emptyIndex,
      emptyRunning,
    );

    expect(Either.isRight(result)).toBe(true);
  });

  test("needs-attention + status=in-progress → Left('needs-attention-not-rearmed') (row 7)", () => {
    const result = isEligible(
      issueDetail({ status: "in-progress" }),
      props({ symphony_state: "needs-attention", symphony_ready: "true" }),
      emptyIndex,
      emptyRunning,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("needs-attention-not-rearmed");
    }
  });

  test("re-armed but dep still open → Left('blocked-by-dependency') (row 5)", () => {
    const dep = "dep-id-open";
    const result = isEligible(
      issueDetail({ dependencies: [dep] }),
      props({ symphony_state: "needs-attention", symphony_ready: "true" }),
      { ids: new Set([dep]), childrenByParent: new Map() },
      emptyRunning,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("blocked-by-dependency");
    }
  });

  test("re-armed but child still open → Left('blocked-by-open-child') (row 5)", () => {
    const result = isEligible(
      issueDetail({ id: "parent-id" }),
      props({ symphony_state: "needs-attention", symphony_ready: "true" }),
      {
        ids: new Set(["open-child"]),
        childrenByParent: new Map([["parent-id", ["open-child"]]]),
      },
      emptyRunning,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("blocked-by-open-child");
    }
  });
});

describe("isEligible — not-todo guard (rows 6 + 8)", () => {
  test("status=in-progress + state=active → Left('not-todo') (row 6)", () => {
    const result = isEligible(
      issueDetail({ status: "in-progress" }),
      props({ symphony_state: "active", symphony_ready: "true" }),
      emptyIndex,
      emptyRunning,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("not-todo");
    }
  });

  test("status=done + state=end → Left('not-todo') (row 8)", () => {
    const result = isEligible(
      issueDetail({ status: "done" }),
      props({ symphony_state: "end", symphony_ready: "true" }),
      emptyIndex,
      emptyRunning,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBe("not-todo");
    }
  });
});

describe("buildOpenIssueIndex", () => {
  test("indexes ids and groups children by parent", () => {
    const index = buildOpenIssueIndex([
      {
        id: "a",
        shortId: "a",
        title: "A",
        status: "todo",
        priority: null,
        parent: null,
        dependencies: [],
        createdAt: "0",
        updatedAt: "0",
      },
      {
        id: "b",
        shortId: "b",
        title: "B",
        status: "in-progress",
        priority: null,
        parent: "a",
        dependencies: [],
        createdAt: "0",
        updatedAt: "0",
      },
      {
        id: "c",
        shortId: "c",
        title: "C",
        status: "todo",
        priority: null,
        parent: "a",
        dependencies: [],
        createdAt: "0",
        updatedAt: "0",
      },
    ]);

    expect(index.ids.has("a")).toBe(true);
    expect(index.ids.has("b")).toBe(true);
    expect(index.ids.has("c")).toBe(true);
    expect(index.childrenByParent.get("a")).toEqual(["b", "c"]);
    expect(index.childrenByParent.get("b")).toBeUndefined();
  });
});
