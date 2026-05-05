import { Effect, Either, Ref } from "effect";

import { AlreadyClaimedError } from "./errors.js";

export type RunningEntry = {
  readonly issueId: string;
  readonly displayId: string;
  readonly attempt: number;
  readonly claimedAt: Date;
};

export type RunningSet = {
  readonly entries: ReadonlyMap<string, RunningEntry>;
};

export const emptyRunningSet: RunningSet = {
  entries: new Map(),
};

export const makeRunningSetRef: Effect.Effect<Ref.Ref<RunningSet>> = Ref.make(emptyRunningSet);

export const isClaimed = (set: RunningSet, issueId: string): boolean => set.entries.has(issueId);

export const claim = (
  set: RunningSet,
  entry: RunningEntry,
): Either.Either<RunningSet, AlreadyClaimedError> => {
  if (isClaimed(set, entry.issueId)) {
    return Either.left(new AlreadyClaimedError({ issueId: entry.issueId }));
  }

  return Either.right({
    entries: new Map(set.entries).set(entry.issueId, entry),
  });
};

export const release = (set: RunningSet, issueId: string): RunningSet => {
  if (!isClaimed(set, issueId)) {
    return set;
  }

  const entries = new Map(set.entries);
  entries.delete(issueId);
  return { entries };
};

export const size = (set: RunningSet): number => set.entries.size;

export const availableSlots = (set: RunningSet, maxConcurrent: number): number =>
  Math.max(0, maxConcurrent - size(set));

export const claimEffect =
  (entry: RunningEntry) =>
  (ref: Ref.Ref<RunningSet>): Effect.Effect<RunningEntry, AlreadyClaimedError> =>
    Ref.modify(ref, (set): [Effect.Effect<RunningEntry, AlreadyClaimedError>, RunningSet] => {
      const result = claim(set, entry);

      if (Either.isLeft(result)) {
        return [Effect.fail(result.left), set];
      }

      return [Effect.succeed(entry), result.right];
    }).pipe(Effect.flatten);

export const releaseEffect =
  (issueId: string) =>
  (ref: Ref.Ref<RunningSet>): Effect.Effect<void> =>
    Ref.update(ref, (set) => release(set, issueId));
