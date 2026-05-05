import { Stream } from "effect";

const NEWLINE = "\n";

const decodeChunkStreaming = (decoder: TextDecoder, chunk: Uint8Array): string =>
  decoder.decode(chunk, { stream: true });

export const frameMessages = <E>(stream: Stream.Stream<Uint8Array, E>): Stream.Stream<string, E> => {
  const decoder = new TextDecoder("utf-8", { fatal: false });

  return stream.pipe(
    Stream.mapAccum("", (buffer, chunk) => {
      const text = buffer + decodeChunkStreaming(decoder, chunk);
      const parts = text.split(NEWLINE);
      const remainder = parts.pop() ?? "";
      const frames = parts.filter((line) => line.length > 0);
      return [remainder, frames];
    }),
    Stream.flatMap(Stream.fromIterable),
  );
};
