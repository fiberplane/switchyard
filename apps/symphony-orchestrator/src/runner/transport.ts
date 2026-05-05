import { Effect, ParseResult, Schema, Stream } from "effect";

import { PARSE_ERROR_LINE_TRUNCATION, ProtocolFramingError, ProtocolParseError } from "./errors.js";

const NEWLINE = "\n";

export const MAX_LINE_BUFFER_SIZE = 10 * 1024 * 1024;

const decodeChunkStreaming = (decoder: TextDecoder, chunk: Uint8Array): string =>
  decoder.decode(chunk, { stream: true });

export const frameMessages = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Stream.Stream<string, E | ProtocolFramingError> => {
  const decoder = new TextDecoder("utf-8", { fatal: false });

  return stream.pipe(
    Stream.mapAccumEffect("", (buffer, chunk) => {
      const text = buffer + decodeChunkStreaming(decoder, chunk);
      const parts = text.split(NEWLINE);
      const remainder = parts.pop() ?? "";

      if (remainder.length > MAX_LINE_BUFFER_SIZE) {
        return Effect.fail(
          new ProtocolFramingError({
            reason: `line buffer exceeded ${MAX_LINE_BUFFER_SIZE} bytes without a newline`,
            bufferedBytes: remainder.length,
          }),
        );
      }

      const frames = parts.filter((line) => line.length > 0);
      return Effect.succeed([remainder, frames] as const);
    }),
    Stream.flatMap(Stream.fromIterable),
  );
};

const decodeJsonUnknown = Schema.decodeUnknown(Schema.parseJson(Schema.Unknown));

const parseLine = (line: string): Effect.Effect<unknown, ProtocolParseError> =>
  decodeJsonUnknown(line).pipe(
    Effect.catchTag("ParseError", (parseError) =>
      Effect.fail(
        new ProtocolParseError({
          reason: ParseResult.TreeFormatter.formatErrorSync(parseError),
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
