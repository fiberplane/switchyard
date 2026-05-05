import { beforeEach, describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import { FpAdapter, type FpAdapterShape, type FpUpdateIssueInput } from "../../src/fp/adapter.js";
import type { FpIssue, FpIssueDetail, FpIssueStatus } from "../../src/fp/models.js";
import { FpService, FpServiceLive } from "../../src/fp/service.js";

type AdapterCall =
  | { readonly method: "listIssuesByStatus"; readonly status: FpIssueStatus }
  | { readonly method: "showIssue"; readonly id: string }
  | { readonly method: "setStatus"; readonly id: string; readonly status: FpIssueStatus }
  | {
      readonly method: "setProperty";
      readonly id: string;
      readonly key: string;
      readonly value: string;
    }
  | { readonly method: "addComment"; readonly id: string; readonly body: string }
  | {
      readonly method: "updateIssue";
      readonly id: string;
      readonly input: FpUpdateIssueInput;
    };

type FakeAdapter = {
  readonly adapter: FpAdapterShape;
  readonly calls: ReadonlyArray<AdapterCall>;
  readonly callLog: AdapterCall[];
};

type FakeScript = {
  readonly listResults?: Partial<Record<FpIssueStatus, ReadonlyArray<FpIssue>>>;
  readonly showResults?: Readonly<Record<string, FpIssueDetail>>;
};

const buildFakeAdapter = (script: FakeScript = {}): FakeAdapter => {
  const callLog: AdapterCall[] = [];

  const adapter: FpAdapterShape = {
    listIssuesByStatus: (status) => {
      callLog.push({ method: "listIssuesByStatus", status });
      return Effect.succeed(script.listResults?.[status] ?? []);
    },
    showIssue: (id) => {
      callLog.push({ method: "showIssue", id });
      const detail = script.showResults?.[id];
      if (detail === undefined) {
        return Effect.die(new Error(`fake adapter: no showIssue script entry for ${id}`));
      }
      return Effect.succeed(detail);
    },
    setStatus: (id, status) => {
      callLog.push({ method: "setStatus", id, status });
      return Effect.void;
    },
    setProperty: (id, key, value) => {
      callLog.push({ method: "setProperty", id, key, value });
      return Effect.void;
    },
    addComment: (id, body) => {
      callLog.push({ method: "addComment", id, body });
      return Effect.void;
    },
    updateIssue: (id, input) => {
      callLog.push({ method: "updateIssue", id, input });
      return Effect.void;
    },
  };

  return {
    adapter,
    callLog,
    get calls() {
      return callLog;
    },
  };
};

const issue = (overrides: Partial<FpIssue> = {}): FpIssue => ({
  id: "issue-id",
  shortId: "id",
  title: "fixture",
  status: "todo",
  priority: null,
  parent: null,
  dependencies: [],
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:00.000Z",
  ...overrides,
});

const detail = (overrides: Partial<FpIssueDetail> = {}): FpIssueDetail => ({
  id: "issue-id",
  displayId: "SWY-id",
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
  ...overrides,
});

const provideService = <A, E>(fake: FakeAdapter, effect: Effect.Effect<A, E, FpService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(FpServiceLive),
      Effect.provide(Layer.succeed(FpAdapter, fake.adapter)),
    ),
  );

const writeMethods = ["setStatus", "setProperty", "addComment"] as const;

const assertNoLegacyWrites = (calls: ReadonlyArray<AdapterCall>) => {
  for (const method of writeMethods) {
    expect(calls.some((call) => call.method === method)).toBe(false);
  }
};

let fake: FakeAdapter;

describe("FpService — atomic writes via updateIssue", () => {
  beforeEach(() => {
    fake = buildFakeAdapter();
  });

  test("claimIssue invokes updateIssue exactly once with status=in-progress + symphony_state=active", async () => {
    await provideService(
      fake,
      Effect.gen(function* () {
        const service = yield* FpService;
        yield* service.claimIssue("issue-id");
      }),
    );

    expect(fake.calls).toEqual([
      {
        method: "updateIssue",
        id: "issue-id",
        input: {
          status: "in-progress",
          properties: { symphony_state: "active" },
        },
      },
    ]);
    assertNoLegacyWrites(fake.calls);
  });

  test("markCompleted invokes updateIssue with status=done, symphony_state=end, and the summary as comment", async () => {
    await provideService(
      fake,
      Effect.gen(function* () {
        const service = yield* FpService;
        yield* service.markCompleted("issue-id", "all done");
      }),
    );

    expect(fake.calls).toEqual([
      {
        method: "updateIssue",
        id: "issue-id",
        input: {
          status: "done",
          properties: { symphony_state: "end" },
          comment: "all done",
        },
      },
    ]);
    assertNoLegacyWrites(fake.calls);
  });

  test("markNeedsAttention invokes updateIssue with symphony_state + last_error + comment, no status change", async () => {
    await provideService(
      fake,
      Effect.gen(function* () {
        const service = yield* FpService;
        yield* service.markNeedsAttention("issue-id", "bundle integration failed");
      }),
    );

    expect(fake.calls).toEqual([
      {
        method: "updateIssue",
        id: "issue-id",
        input: {
          properties: {
            symphony_state: "needs-attention",
            symphony_last_error: "bundle integration failed",
          },
          comment: "bundle integration failed",
        },
      },
    ]);
    assertNoLegacyWrites(fake.calls);
  });

  test("setAttempt invokes updateIssue with only symphony_attempt", async () => {
    await provideService(
      fake,
      Effect.gen(function* () {
        const service = yield* FpService;
        yield* service.setAttempt("issue-id", 2);
      }),
    );

    expect(fake.calls).toEqual([
      {
        method: "updateIssue",
        id: "issue-id",
        input: { properties: { symphony_attempt: "2" } },
      },
    ]);
    assertNoLegacyWrites(fake.calls);
  });

  test("setArtifact invokes updateIssue with only symphony_artifact", async () => {
    await provideService(
      fake,
      Effect.gen(function* () {
        const service = yield* FpService;
        yield* service.setArtifact("issue-id", "symphony/SWY-id");
      }),
    );

    expect(fake.calls).toEqual([
      {
        method: "updateIssue",
        id: "issue-id",
        input: { properties: { symphony_artifact: "symphony/SWY-id" } },
      },
    ]);
    assertNoLegacyWrites(fake.calls);
  });
});

describe("FpService.fetchCandidates — two-phase fetch shape", () => {
  test("issues two list calls and one showIssue per todo issue, returns no rejections when all eligible", async () => {
    const a = issue({ id: "a", shortId: "a" });
    const b = issue({ id: "b", shortId: "b" });
    const d = issue({ id: "d", shortId: "d", status: "in-progress" });

    fake = buildFakeAdapter({
      listResults: { todo: [a, b], "in-progress": [d] },
      showResults: {
        a: detail({
          id: "a",
          displayId: "SWY-a",
          properties: { symphony_state: "idle", symphony_ready: "true" },
        }),
        b: detail({
          id: "b",
          displayId: "SWY-b",
          properties: { symphony_state: "idle", symphony_ready: "true" },
        }),
      },
    });

    const result = await provideService(
      fake,
      Effect.gen(function* () {
        const service = yield* FpService;
        return yield* service.fetchCandidates(new Set());
      }),
    );

    const listCalls = fake.calls.filter((call) => call.method === "listIssuesByStatus");
    const showCalls = fake.calls.filter((call) => call.method === "showIssue");
    expect(listCalls).toHaveLength(2);
    expect(showCalls).toHaveLength(2);
    expect(showCalls.map((call) => (call.method === "showIssue" ? call.id : ""))).toEqual([
      "a",
      "b",
    ]);
    expect(result.eligible.map((entry) => entry.detail.id)).toEqual(["a", "b"]);
    expect(result.rejected).toEqual([]);
  });

  test("filters via isEligible and reports rejection reasons", async () => {
    const a = issue({ id: "a", shortId: "a" });
    const b = issue({ id: "b", shortId: "b" });
    const c = issue({ id: "c", shortId: "c" });
    const d = issue({ id: "d", shortId: "d", status: "in-progress", parent: "c" });

    fake = buildFakeAdapter({
      listResults: { todo: [a, b, c], "in-progress": [d] },
      showResults: {
        a: detail({
          id: "a",
          displayId: "SWY-a",
          properties: { symphony_state: "idle", symphony_ready: "true" },
        }),
        b: detail({
          id: "b",
          displayId: "SWY-b",
          properties: { symphony_state: "idle", symphony_ready: "false" },
        }),
        c: detail({
          id: "c",
          displayId: "SWY-c",
          properties: { symphony_state: "idle", symphony_ready: "true" },
        }),
      },
    });

    const result = await provideService(
      fake,
      Effect.gen(function* () {
        const service = yield* FpService;
        return yield* service.fetchCandidates(new Set());
      }),
    );

    expect(result.eligible.map((entry) => entry.detail.id)).toEqual(["a"]);
    expect(result.rejected).toEqual([
      { id: "b", displayId: "SWY-b", reason: "not-ready" },
      { id: "c", displayId: "SWY-c", reason: "blocked-by-open-child" },
    ]);
  });

  test("excludes a malformed-symphony-properties candidate without aborting the scan", async () => {
    const a = issue({ id: "a", shortId: "a" });
    const bad = issue({ id: "bad", shortId: "bad" });

    fake = buildFakeAdapter({
      listResults: { todo: [a, bad], "in-progress": [] },
      showResults: {
        a: detail({
          id: "a",
          displayId: "SWY-a",
          properties: { symphony_state: "idle", symphony_ready: "true" },
        }),
        bad: detail({
          id: "bad",
          displayId: "SWY-bad",
          properties: { symphony_state: "garbage" },
        }),
      },
    });

    const result = await provideService(
      fake,
      Effect.gen(function* () {
        const service = yield* FpService;
        return yield* service.fetchCandidates(new Set());
      }),
    );

    expect(result.eligible.map((entry) => entry.detail.id)).toEqual(["a"]);
    expect(result.rejected).toEqual([
      { id: "bad", displayId: "SWY-bad", reason: "malformed-symphony-properties" },
    ]);
  });

  test("respects the runningSet — already-running issues are rejected", async () => {
    const a = issue({ id: "a", shortId: "a" });

    fake = buildFakeAdapter({
      listResults: { todo: [a], "in-progress": [] },
      showResults: {
        a: detail({
          id: "a",
          displayId: "SWY-a",
          properties: { symphony_state: "idle", symphony_ready: "true" },
        }),
      },
    });

    const result = await provideService(
      fake,
      Effect.gen(function* () {
        const service = yield* FpService;
        return yield* service.fetchCandidates(new Set(["a"]));
      }),
    );

    expect(result.eligible).toEqual([]);
    expect(result.rejected).toEqual([{ id: "a", displayId: "SWY-a", reason: "already-running" }]);
  });
});
