import { join } from "node:path";

import { Error as PlatformError, FileSystem } from "@effect/platform";
import { Effect } from "effect";

import type { RunnerNotification } from "../runner/session.js";
import { TranscriptWriteError } from "./errors.js";

// Per-attempt JSONL output filename. Aligned with the umbrella spec
// (`transcript.jsonl` under `.symphony/runs/<issue>/<attempt>/`).
export const TRANSCRIPT_FILENAME = "transcript.jsonl";

const formatJsonl = (events: ReadonlyArray<RunnerNotification>): string =>
  events.map((event) => `${JSON.stringify(event)}\n`).join("");

const mapPlatformError = (path: string, operation: string) =>
  (error: PlatformError.PlatformError): TranscriptWriteError =>
    new TranscriptWriteError({ path, operation, reason: error.message });

// Buffered, post-completion transcript writer. Consumes the runner's
// `TurnOutcome.events` array after `runTurn` returns and flushes a single JSONL
// file. The streaming variant (live persistence as events arrive) is deferred
// to SWYRD-aaytmsfz; on protocol-stream failure mid-turn the runner produces no
// events to write and the transcript file is empty.
export const writeTranscript = (
  runDir: string,
  events: ReadonlyArray<RunnerNotification>,
): Effect.Effect<string, TranscriptWriteError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = join(runDir, TRANSCRIPT_FILENAME);

    yield* fs
      .makeDirectory(runDir, { recursive: true })
      .pipe(Effect.mapError(mapPlatformError(runDir, "create directory")));

    yield* fs
      .writeFileString(path, formatJsonl(events))
      .pipe(Effect.mapError(mapPlatformError(path, "write file")));

    return path;
  }).pipe(Effect.withSpan("orchestrator.transcript.write"));
