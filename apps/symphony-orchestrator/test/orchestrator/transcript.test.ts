import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";

import { writeTranscript, TRANSCRIPT_FILENAME } from "../../src/orchestrator/transcript.js";
import type { RunnerNotification } from "../../src/runner/session.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "swy-transcript-test-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const events: ReadonlyArray<RunnerNotification> = [
  { method: "thread/start", params: { threadId: "t1" } },
  { method: "turn/start", params: { turnId: "tu1" } },
  { method: "turn/completed", params: { ok: true } },
];

describe("orchestrator transcript", () => {
  test("writes one JSONL line per event under runDir", async () => {
    const runDir = join(workdir, "issue/1");
    await Effect.runPromise(
      writeTranscript(runDir, events).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    const path = join(runDir, TRANSCRIPT_FILENAME);
    const content = await readFile(path, "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    for (let i = 0; i < lines.length; i += 1) {
      expect(JSON.parse(lines[i]!)).toEqual(events[i]!);
    }
  });

  test("creates the run directory when it does not exist", async () => {
    const runDir = join(workdir, "deeply", "nested", "issue", "1");
    await Effect.runPromise(
      writeTranscript(runDir, events.slice(0, 1)).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    const path = join(runDir, TRANSCRIPT_FILENAME);
    const content = await readFile(path, "utf8");
    expect(content).toBe(`${JSON.stringify(events[0])}\n`);
  });

  test("writes an empty-but-present transcript file when given an empty events array", async () => {
    const runDir = join(workdir, "empty");
    await Effect.runPromise(writeTranscript(runDir, []).pipe(Effect.provide(NodeFileSystem.layer)));

    const path = join(runDir, TRANSCRIPT_FILENAME);
    const content = await readFile(path, "utf8");
    expect(content).toBe("");
  });
});
