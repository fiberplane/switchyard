import { join } from "node:path";

import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";

import { ArtifactDecodeError, ArtifactPathError } from "./errors.js";
import {
  decodeOrchestratorRecordJson,
  encodeOrchestratorRecord,
  type OrchestratorRecord,
  type OrchestratorRecordEncoded,
} from "./models.js";

export type ArtifactStoreShape = {
  readonly runDir: (issueId: string, attempt: number) => string;
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

const recordPath = (runDir: string): string => join(runDir, "outcome-record.json");

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
  runDir: (issueId, attempt) => join(basePath, "runs", issueId, String(attempt)),
  writeRecord: (issueId, attempt, record) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = join(basePath, "runs", issueId, String(attempt));
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
      const path = recordPath(join(basePath, "runs", issueId, String(attempt)));
      const content = yield* fs
        .readFileString(path)
        .pipe(Effect.mapError(mapPathError(path, "read file")));

      return yield* decodeOrchestratorRecordJson(content, path);
    }),
});

export const ArtifactStoreLive = (basePath: string) =>
  Layer.succeed(ArtifactStore, makeArtifactStore(basePath));
