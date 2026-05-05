import { describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Stream } from "effect";

import { ProtocolFramingError, ProtocolParseError } from "../../src/runner/errors.js";
import {
  MAX_LINE_BUFFER_SIZE,
  encodeMessage,
  frameMessages,
  parseFrames,
} from "../../src/runner/transport.js";
import { loadFixtureProtocolStream } from "./test-helpers/fixture-stream.js";

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

  it("flushes a non-empty buffer as a final frame when the stream ends without a trailing newline", async () => {
    const input = Stream.fromIterable([utf8('{"a":1}\n{"b":'), utf8("2}")]);
    const frames = await Effect.runPromise(Stream.runCollect(frameMessages(input)));
    expect(Array.from(frames)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("emits no extra frame when the stream ends with an empty buffer", async () => {
    const input = Stream.make(utf8('{"a":1}\n'));
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

describe("encodeMessage", () => {
  it("emits JSON.stringify(message) + '\\n' as UTF-8 bytes", () => {
    const msg = { id: 1, method: "initialize", params: {} };
    const encoded = encodeMessage(msg);
    expect(encoded).toEqual(utf8(`${JSON.stringify(msg)}\n`));
  });

  it("round-trips through frameMessages + parseFrames", async () => {
    const msg = { id: 1, method: "initialize", params: { foo: "bar" } };
    const bytes = encodeMessage(msg);
    const recovered = await Effect.runPromise(
      Stream.runCollect(parseFrames(frameMessages(Stream.make(bytes)))),
    );
    expect(Array.from(recovered)).toEqual([msg]);
  });
});

describe("transport composed over happy-path fixture", () => {
  it("decodes every recv frame to an object whose top-level keys match the recorded shape", async () => {
    const helper = await Effect.runPromise(loadFixtureProtocolStream("happy-path-turn.jsonl"));
    const decoded = await Effect.runPromise(
      Stream.runCollect(parseFrames(frameMessages(helper.stream.receive))),
    );
    const messages = Array.from(decoded) as ReadonlyArray<Record<string, unknown>>;

    // Per the fixture meta the happy-path capture has 20 recv frames.
    expect(messages.length).toBe(20);

    for (const message of messages) {
      // Every codex app-server frame is either a JSON-RPC response (id+result/error)
      // or a notification (method+params). At least one of those keys must be present.
      const hasResponseShape = "id" in message && ("result" in message || "error" in message);
      const hasNotificationShape = "method" in message;
      expect(hasResponseShape || hasNotificationShape).toBe(true);
    }

    // The handshake responses for id=1 (initialize) and id=2 (thread/start) must be present.
    const responseIds = messages.filter((m) => "id" in m).map((m) => m.id);
    expect(responseIds).toContain(1);
    expect(responseIds).toContain(2);

    // The terminal turn/completed notification must be the final frame.
    const last = messages.at(-1);
    expect(last?.method).toBe("turn/completed");
  });
});

describe("transport composed over approval-roundtrip fixture", () => {
  it("decodes the approval-request frame whose method matches an approval shape", async () => {
    const helper = await Effect.runPromise(loadFixtureProtocolStream("approval-roundtrip.jsonl"));
    const decoded = await Effect.runPromise(
      Stream.runCollect(parseFrames(frameMessages(helper.stream.receive))),
    );
    const messages = Array.from(decoded) as ReadonlyArray<Record<string, unknown>>;

    // Per the fixture meta the approval-roundtrip capture has 58 recv frames.
    expect(messages.length).toBe(58);

    const approvalRequests = messages.filter((m) => {
      const method = m.method;
      return (
        typeof method === "string" &&
        (method.startsWith("applyPatchApproval") ||
          method.startsWith("execCommandApproval") ||
          method.includes("requestApproval"))
      );
    });
    expect(approvalRequests.length).toBeGreaterThan(0);

    // Final frame must still be the terminal turn/completed notification.
    const last = messages.at(-1);
    expect(last?.method).toBe("turn/completed");
  });
});
