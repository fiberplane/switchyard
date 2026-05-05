import { describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";

import { frameMessages } from "../../src/runner/transport.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("frameMessages", () => {
  it("splits a two-line stream into two frames", async () => {
    const input = Stream.make(utf8('{"a":1}\n{"b":2}\n'));
    const frames = await Effect.runPromise(Stream.runCollect(frameMessages(input)));
    expect(Array.from(frames)).toEqual(['{"a":1}', '{"b":2}']);
  });
});
