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

// Strip leading C0 control bytes (0x00..0x1F) other than tab. The daytona
// session bridge can prepend SOH () and similar framing/multiplex bytes
// to a frame's payload; the JSON itself is well-formed and valid downstream
// once the prefix is removed. See SWYRD-flbsjoyb for the field repro.
//
// Intentionally narrow: DEL (0x7F), C1 controls (0x80..0x9F), and BOM
// (U+FEFF) are NOT stripped — those have not been observed in the field and
// silently eating them would mask upstream encoding bugs. They will surface
// as ProtocolParseError carrying the raw line for diagnosis.
const stripLeadingControlBytes = (line: string): string => {
  let i = 0;
  for (; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code >= 0x20 || code === 0x09) {
      break;
    }
  }
  return i === 0 ? line : line.slice(i);
};

const parseLine = (line: string): Effect.Effect<unknown, ProtocolParseError> =>
  decodeJsonUnknown(stripLeadingControlBytes(line)).pipe(
    Effect.catchTag("ParseError", (parseError) =>
      Effect.fail(
        // Keep the original (un-stripped) line in the error so operators can
        // see the raw bytes when diagnosing — strip is a parse-time concession,
        // not a logging one.
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
