import { describe, expect, test } from "bun:test";

import { Effect, Either, Ref } from "effect";

import { AlreadyClaimedError } from "../../src/orchestrator/errors.js";
import {
  availableSlots,
  claim,
  claimEffect,
  emptyRunningSet,
  isClaimed,
  makeRunningSetRef,
  release,
  releaseEffect,
  size,
  type RunningEntry,
} from "../../src/orchestrator/state.js";

const entry = (issueId = "jrcqjjmo"): RunningEntry => ({
  issueId,
  displayId: `SWYRD-${issueId}`,
  attempt: 1,
  claimedAt: new Date("2026-05-05T00:00:00.000Z"),
});

const expectRight = <A, E>(result: Either.Either<A, E>): A => {
  expect(Either.isRight(result)).toBe(true);
  if (Either.isLeft(result)) {
    throw result.left;
  }
  return result.right;
};

describe("orchestrator running set", () => {
  test("starts empty and reports unclaimed issue ids", () => {
    expect(size(emptyRunningSet)).toBe(0);
    expect(isClaimed(emptyRunningSet, "any")).toBe(false);
  });

  test("claims an entry and rejects duplicate issue ids", () => {
    const first = expectRight(claim(emptyRunningSet, entry()));

    expect(size(first)).toBe(1);
    expect(isClaimed(first, "jrcqjjmo")).toBe(true);
    expect(first.entries.get("jrcqjjmo")).toEqual(entry());

    const duplicate = claim(first, entry());

    expect(Either.isLeft(duplicate)).toBe(true);
    if (Either.isLeft(duplicate)) {
      expect(duplicate.left).toBeInstanceOf(AlreadyClaimedError);
      expect(duplicate.left.issueId).toBe("jrcqjjmo");
    }
  });

  test("releases claimed entries and treats missing ids as a no-op", () => {
    const claimed = expectRight(claim(emptyRunningSet, entry()));
    const released = release(claimed, "jrcqjjmo");

    expect(size(released)).toBe(0);
    expect(isClaimed(released, "jrcqjjmo")).toBe(false);
    expect(release(released, "missing")).toBe(released);
  });

  test("reports available single-flight slots", () => {
    const claimed = expectRight(claim(emptyRunningSet, entry()));

    expect(availableSlots(emptyRunningSet, 1)).toBe(1);
    expect(availableSlots(claimed, 1)).toBe(0);
  });

  test("creates a Ref initialized to the empty running set", async () => {
    const set = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* makeRunningSetRef;
        return yield* Ref.get(ref);
      }),
    );

    expect(set).toEqual(emptyRunningSet);
  });

  test("claims through a Ref atomically and fails duplicate claims", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* makeRunningSetRef;
        const claimed = yield* claimEffect(entry())(ref);
        const duplicate = yield* Effect.either(claimEffect(entry())(ref));
        const set = yield* Ref.get(ref);
        return { claimed, duplicate, set };
      }),
    );

    expect(result.claimed).toEqual(entry());
    expect(size(result.set)).toBe(1);
    expect(Either.isLeft(result.duplicate)).toBe(true);
    if (Either.isLeft(result.duplicate)) {
      expect(result.duplicate.left).toBeInstanceOf(AlreadyClaimedError);
      expect(result.duplicate.left.issueId).toBe("jrcqjjmo");
    }
  });

  test("releases through a Ref", async () => {
    const set = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* makeRunningSetRef;
        yield* claimEffect(entry())(ref);
        yield* releaseEffect("jrcqjjmo")(ref);
        return yield* Ref.get(ref);
      }),
    );

    expect(size(set)).toBe(0);
    expect(isClaimed(set, "jrcqjjmo")).toBe(false);
  });

  test("allows exactly one winner when fibers race to claim the same issue", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* makeRunningSetRef;
        const claims = Array.from({ length: 10 }, () => Effect.either(claimEffect(entry())(ref)));
        const results = yield* Effect.all(claims, { concurrency: "unbounded" });
        const set = yield* Ref.get(ref);

        return { results, set };
      }),
    );

    const successes = result.results.filter(Either.isRight);
    const failures = result.results.filter(Either.isLeft);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(9);
    expect(size(result.set)).toBe(1);
    expect(isClaimed(result.set, "jrcqjjmo")).toBe(true);
    for (const failure of failures) {
      expect(failure.left).toBeInstanceOf(AlreadyClaimedError);
      expect(failure.left.issueId).toBe("jrcqjjmo");
    }
  });
});
