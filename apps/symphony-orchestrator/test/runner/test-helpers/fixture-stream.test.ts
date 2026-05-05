import { describe, expect, it } from "bun:test";

import { Effect, Stream } from "effect";

import { loadFixtureProtocolStream } from "./fixture-stream.js";

const decoder = new TextDecoder();

describe("fixture-stream helper", () => {
  it("re-encodes recv frames as JSON.stringify(message) + '\\n' bytes", async () => {
    const helper = await Effect.runPromise(loadFixtureProtocolStream("happy-path-turn.jsonl"));
    const recv = await Effect.runPromise(Stream.runCollect(helper.stream.receive));
    const lines = Array.from(recv).map((bytes) => decoder.decode(bytes));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      // Re-parsing each line must succeed (only message-structure round-trips).
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("records send calls without doing real I/O", async () => {
    const helper = await Effect.runPromise(loadFixtureProtocolStream("happy-path-turn.jsonl"));
    const payload = new TextEncoder().encode("ping\n");
    await Effect.runPromise(helper.stream.send(payload));
    await Effect.runPromise(helper.stream.send(payload));
    expect(helper.sent.length).toBe(2);
    expect(helper.sent[0]).toEqual(payload);
    expect(helper.sent[1]).toEqual(payload);
  });
});
