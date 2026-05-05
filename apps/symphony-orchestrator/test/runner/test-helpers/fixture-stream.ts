// Replays a captured codex app-server fixture as a runner ProtocolStream.
//
// Second-order encoding: each recv frame is re-encoded via
// `JSON.stringify(message) + "\n"`. The helper does not preserve the live
// process's exact byte-level JSON formatting (whitespace, key order); only
// the message structure round-trips. Tests that depend on byte-exact wire
// shape need a different fixture path (the `service.ts` integration test
// owns that).

import { join } from "node:path";

import { Effect, Schema, Stream } from "effect";

import { ProtocolRecvError } from "../../../src/runner/errors.js";
import type { ProtocolStream } from "../../../src/runner/transport.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures");

const FixtureLine = Schema.Struct({
  ts: Schema.String,
  direction: Schema.Literal("send", "recv"),
  message: Schema.Unknown,
});

const decodeFixtureLine = Schema.decodeUnknown(Schema.parseJson(FixtureLine));

const readFixtureFile = (relativePath: string): Effect.Effect<string, ProtocolRecvError> =>
  Effect.tryPromise({
    try: () => Bun.file(join(FIXTURE_DIR, relativePath)).text(),
    catch: (error) =>
      new ProtocolRecvError({
        reason: `failed to read fixture ${relativePath}: ${String(error)}`,
      }),
  });

const encoder = new TextEncoder();

const encodeFrame = (message: unknown): Uint8Array =>
  encoder.encode(`${JSON.stringify(message)}\n`);

export type FixtureProtocolStreamHelper = {
  readonly stream: ProtocolStream;
  readonly sent: ReadonlyArray<Uint8Array>;
};

export const loadFixtureProtocolStream = (
  relativePath: string,
): Effect.Effect<FixtureProtocolStreamHelper, ProtocolRecvError> =>
  Effect.gen(function* () {
    const text = yield* readFixtureFile(relativePath);
    const lines = text.split("\n").filter((line) => line.length > 0);

    const recvFrames: Uint8Array[] = [];
    for (const line of lines) {
      const decoded = yield* decodeFixtureLine(line).pipe(
        Effect.mapError(
          (parseError) =>
            new ProtocolRecvError({
              reason: `fixture ${relativePath} line decode failed: ${String(parseError)}`,
            }),
        ),
      );
      if (decoded.direction === "recv") {
        recvFrames.push(encodeFrame(decoded.message));
      }
    }

    const sent: Uint8Array[] = [];
    const stream: ProtocolStream = {
      send: (bytes) =>
        Effect.sync(() => {
          sent.push(bytes);
        }).pipe(Effect.asVoid),
      receive: Stream.fromIterable<Uint8Array>(recvFrames),
    };

    return { stream, sent };
  });
