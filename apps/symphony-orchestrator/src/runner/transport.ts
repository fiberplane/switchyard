import { Effect, ParseResult, Ref, Schema, Stream } from "effect";

import {
  PARSE_ERROR_LINE_TRUNCATION,
  ProtocolFramingError,
  ProtocolParseError,
  ProtocolRecvError,
  ProtocolSendError,
} from "./errors.js";

export type ProtocolStream = {
  readonly send: (bytes: Uint8Array) => Effect.Effect<void, ProtocolSendError>;
  readonly receive: Stream.Stream<Uint8Array, ProtocolRecvError>;
};

const NEWLINE = "\n";

export const MAX_LINE_BUFFER_SIZE = 10 * 1024 * 1024;

export const frameMessages = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Stream.Stream<string, E | ProtocolFramingError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Per-subscription decoder + buffer; no shared mutable state across subscribers.
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const bufferRef = yield* Ref.make("");

      const chunkFrames = (
        chunk: Uint8Array,
      ): Effect.Effect<readonly string[], ProtocolFramingError> =>
        Effect.gen(function* () {
          const buffer = yield* Ref.get(bufferRef);
          const text = buffer + decoder.decode(chunk, { stream: true });
          const parts = text.split(NEWLINE);
          const remainder = parts.pop() ?? "";

          if (remainder.length > MAX_LINE_BUFFER_SIZE) {
            // On overflow we fail the recv stream and do NOT reset the buffer
            // like brettimus runner.ts:138-141. Stream.concat(main, tail) below
            // means the tail flush is intentionally skipped on this failure path.
            return yield* Effect.fail(
              new ProtocolFramingError({
                reason: `line buffer exceeded ${MAX_LINE_BUFFER_SIZE} chars without a newline`,
                bufferedChars: remainder.length,
              }),
            );
          }

          yield* Ref.set(bufferRef, remainder);
          return parts.filter((line) => line.length > 0);
        });

      const main = stream.pipe(Stream.mapEffect(chunkFrames), Stream.flatMap(Stream.fromIterable));

      const tail = Stream.unwrap(
        Ref.get(bufferRef).pipe(
          Effect.map((buffered) => {
            // Drain any trailing partial UTF-8 sequence held inside the decoder
            // before flushing. Without this, a final byte sequence that did not
            // fall on a code-point boundary would never reach the buffer and
            // the last frame would be silently truncated.
            const trailing = decoder.decode();
            const last = buffered + trailing;
            return last.length > 0 ? Stream.make(last) : Stream.empty;
          }),
        ),
      );

      return Stream.concat(main, tail);
    }),
  );

const decodeJsonUnknown = Schema.decodeUnknown(Schema.parseJson(Schema.Unknown));

const parseLine = (line: string): Effect.Effect<unknown, ProtocolParseError> =>
  decodeJsonUnknown(line).pipe(
    Effect.catchTag("ParseError", (parseError) =>
      Effect.fail(
        new ProtocolParseError({
          reason: ParseResult.TreeFormatter.formatErrorSync(parseError).slice(
            0,
            PARSE_ERROR_LINE_TRUNCATION,
          ),
          line: line.slice(0, PARSE_ERROR_LINE_TRUNCATION),
        }),
      ),
    ),
  );

export const parseFrames = <E>(
  lines: Stream.Stream<string, E>,
): Stream.Stream<unknown, E | ProtocolParseError> => lines.pipe(Stream.mapEffect(parseLine));

const encoder = new TextEncoder();

export const encodeMessage = (message: unknown): Uint8Array =>
  encoder.encode(`${JSON.stringify(message)}\n`);
