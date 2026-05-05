import { describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Stream } from "effect";

import { ProtocolFramingError, ProtocolParseError } from "../../src/runner/errors.js";
import { MAX_LINE_BUFFER_SIZE, frameMessages, parseFrames } from "../../src/runner/transport.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("frameMessages", () => {
  it("splits a two-line stream into two frames", async () => {
    const input = Stream.make(utf8('{"a":1}\n{"b":2}\n'));
    const frames = await Effect.runPromise(Stream.runCollect(frameMessages(input)));
    expect(Array.from(frames)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("reassembles a single frame split across two chunks", async () => {
    const input = Stream.fromIterable([utf8('{"a":'), utf8("1}\n")]);
    const frames = await Effect.runPromise(Stream.runCollect(frameMessages(input)));
    expect(Array.from(frames)).toEqual(['{"a":1}']);
  });

  it("fails with ProtocolFramingError when the buffer exceeds MAX_LINE_BUFFER_SIZE", async () => {
    const oversize = utf8("x".repeat(MAX_LINE_BUFFER_SIZE + 1));
    const exit = await Effect.runPromiseExit(Stream.runCollect(frameMessages(Stream.make(oversize))));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProtocolFramingError);
      }
    }
  });
});

describe("parseFrames", () => {
  it("emits parsed values in order for valid JSON frames", async () => {
    const lines = Stream.fromIterable(['{"a":1}', '{"b":2}', '"hello"']);
    const parsed = await Effect.runPromise(Stream.runCollect(parseFrames(lines)));
    expect(Array.from(parsed)).toEqual([{ a: 1 }, { b: 2 }, "hello"]);
  });

  it("fails with ProtocolParseError carrying the offending line truncated to 500 chars", async () => {
    const longBadLine = `${"a".repeat(800)}}`;
    const lines = Stream.make(longBadLine);
    const exit = await Effect.runPromiseExit(Stream.runCollect(parseFrames(lines)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProtocolParseError);
        const err = failure.value as ProtocolParseError;
        expect(err.line.length).toBe(500);
        expect(err.line).toBe(longBadLine.slice(0, 500));
      }
    }
  });
});
