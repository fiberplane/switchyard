import { Effect, Stream } from "effect";

import { ProtocolFramingError } from "./errors.js";

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
