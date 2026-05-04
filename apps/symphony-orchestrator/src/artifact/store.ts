import { join } from "node:path";

import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";

import { ArtifactDecodeError, ArtifactPathError } from "./errors.js";
import {
  decodeOrchestratorRecordJson,
  decodeWorkerOutcomeJson,
  encodeOrchestratorRecord,
  type OrchestratorRecord,
  type OrchestratorRecordEncoded,
  type WorkerOutcome,
} from "./models.js";

export type ArtifactStoreShape = {
  readonly runDir: (issueId: string, attempt: number) => string;
  readonly listRuns: (
    issueId: string,
  ) => Effect.Effect<Array<number>, ArtifactPathError, FileSystem.FileSystem>;
  readonly readOutcome: (
    issueId: string,
    attempt: number,
  ) => Effect.Effect<WorkerOutcome, ArtifactPathError | ArtifactDecodeError, FileSystem.FileSystem>;
  readonly writeRecord: (
    issueId: string,
    attempt: number,
    record: OrchestratorRecord,
  ) => Effect.Effect<void, ArtifactPathError | ArtifactDecodeError, FileSystem.FileSystem>;
  readonly readRecord: (
    issueId: string,
    attempt: number,
  ) => Effect.Effect<
    OrchestratorRecord,
    ArtifactPathError | ArtifactDecodeError,
    FileSystem.FileSystem
  >;
};

export class ArtifactStore extends Context.Tag("ArtifactStore")<
  ArtifactStore,
  ArtifactStoreShape
>() {}

const describeUnknown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const mapPathError = (path: string, operation: string) => (error: unknown) =>
  new ArtifactPathError({
    path,
    operation,
    reason: describeUnknown(error),
  });

const issueRunsDir = (basePath: string, issueId: string): string => join(basePath, "runs", issueId);

const runDirFor = (basePath: string, issueId: string, attempt: number): string =>
  join(issueRunsDir(basePath, issueId), String(attempt));

const recordPath = (runDir: string): string => join(runDir, "outcome-record.json");

const outcomePath = (runDir: string): string => join(runDir, "outcome.json");

const parseAttemptDirectory = (
  entry: string,
): { readonly entry: string; readonly attempt: number } | null => {
  if (!/^[1-9]\d*$/.test(entry)) {
    return null;
  }
  return { entry, attempt: Number(entry) };
};

const isNumber = (value: number | null): value is number => value !== null;

const formatRecordJson = (record: OrchestratorRecordEncoded): string =>
  `${JSON.stringify(
    {
      status: record.status,
      branch: record.branch,
      baseRev: record.baseRev,
      workerStatus: record.workerStatus,
      ...(record.integrationError !== undefined
        ? { integrationError: record.integrationError }
        : {}),
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      attempt: record.attempt,
    },
    null,
    2,
  )}\n`;

const makeArtifactStore = (basePath: string): ArtifactStoreShape => ({
  runDir: (issueId, attempt) => runDirFor(basePath, issueId, attempt),
  listRuns: (issueId) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const issueDir = issueRunsDir(basePath, issueId);
      const exists = yield* fs
        .exists(issueDir)
        .pipe(Effect.mapError(mapPathError(issueDir, "check directory")));

      if (!exists) {
        return [];
      }

      const entries = yield* fs
        .readDirectory(issueDir)
        .pipe(Effect.mapError(mapPathError(issueDir, "read directory")));
      const attemptEntries = entries.flatMap((entry) => {
        const parsed = parseAttemptDirectory(entry);
        return parsed === null ? [] : [parsed];
      });
      const attempts = yield* Effect.forEach(attemptEntries, ({ entry, attempt }) =>
        fs.stat(join(issueDir, entry)).pipe(
          Effect.map((info) => (info.type === "Directory" ? attempt : null)),
          Effect.mapError(mapPathError(join(issueDir, entry), "stat path")),
        ),
      );

      return attempts.filter(isNumber).sort((left, right) => left - right);
    }),
  readOutcome: (issueId, attempt) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = outcomePath(runDirFor(basePath, issueId, attempt));
      const content = yield* fs
        .readFileString(path)
        .pipe(Effect.mapError(mapPathError(path, "read file")));

      return yield* decodeWorkerOutcomeJson(content, path);
    }),
  writeRecord: (issueId, attempt, record) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = runDirFor(basePath, issueId, attempt);
      const path = recordPath(dir);
      const encoded = yield* encodeOrchestratorRecord(record, path);

      yield* fs
        .makeDirectory(dir, { recursive: true })
        .pipe(Effect.mapError(mapPathError(dir, "create directory")));
      yield* fs
        .writeFileString(path, formatRecordJson(encoded))
        .pipe(Effect.mapError(mapPathError(path, "write file")));
    }),
  readRecord: (issueId, attempt) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = recordPath(runDirFor(basePath, issueId, attempt));
      const content = yield* fs
        .readFileString(path)
        .pipe(Effect.mapError(mapPathError(path, "read file")));

      return yield* decodeOrchestratorRecordJson(content, path);
    }),
});

export const ArtifactStoreLive = (basePath: string) =>
  Layer.succeed(ArtifactStore, makeArtifactStore(basePath));
