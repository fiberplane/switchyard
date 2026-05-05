// Spike for SWYRD-wnzgxnsi: does the Daytona session API support bidirectional
// stdio for a long-running command?
//
// Strategy: launch a long-lived stdin-reading bash loop in a session command
// (runAsync: true), stream its output via getSessionCommandLogs(onStdout,
// onStderr), write distinct lines to stdin via sendSessionCommandInput, and
// assert each round-trip arrives.
//
// Outcome documented in docs/experiments/2026-05-05-daytona-bidirectional-stdio.md.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Daytona } from "@daytona/sdk";
import type {} from "bun";

interface RoundTripProbe {
  readonly index: number;
  readonly sentAt: string;
  readonly received: boolean;
  readonly receivedAt?: string;
  readonly elapsedMs?: number;
  readonly expected: string;
  readonly observed?: string;
}

const getRequired = (name: string, fallbackPath?: string) => {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (fallbackPath && existsSync(fallbackPath)) {
    return readFileSync(fallbackPath, "utf8").trim();
  }
  throw new Error(`${name} is required`);
};

const apiKey = getRequired("DAYTONA_API_KEY", process.env.DAYTONA_API_KEY_FILE);
const apiUrl = process.env.DAYTONA_API_URL || "http://localhost:3000/api";
const target = process.env.DAYTONA_TARGET || "us";
const snapshotName = process.env.DAYTONA_SNAPSHOT || "symphony-codex-bun";

const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
const artifactDir = join(process.cwd(), "artifacts", `spike-stdio-${timestamp}`);
mkdirSync(artifactDir, { recursive: true });
chmodSync(artifactDir, 0o700);

console.log(`artifactDir=${artifactDir}`);
console.log(`apiUrl=${apiUrl}`);
console.log(`target=${target}`);
console.log(`snapshot=${snapshotName}`);

const daytona = new Daytona({ apiKey, apiUrl, target });

const probes: RoundTripProbe[] = [];
const stdoutChunks: { at: string; chunk: string }[] = [];
const stderrChunks: { at: string; chunk: string }[] = [];
let sandbox: Awaited<ReturnType<Daytona["create"]>> | undefined;
let sessionToCleanup: string | undefined;
let deleted = false;
let outcome: "success" | "failure" = "failure";
let failureReason: string | null = null;

const echoSentinel = "__SPIKE_EOF__";

const messages = [
  "msg-1",
  "msg-2",
  "msg-3-with-spaces and unicode α β γ",
  "msg-4-binary-ish: \"quotes\" 'apos' $dollar `tick` \\back",
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Wait until predicate holds or timeout. Polls in-memory state populated by
// the streaming callbacks; no extra round-trips against the API.
const waitFor = async (predicate: () => boolean, timeoutMs: number, intervalMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
  return true;
};

try {
  const snapshot = await daytona.snapshot.get(snapshotName);
  if (snapshot.state !== "active") {
    throw new Error(`Snapshot ${snapshotName} is ${snapshot.state}, not active`);
  }

  sandbox = await daytona.create(
    {
      name: `spike-stdio-${Date.now()}`,
      snapshot: snapshotName,
      language: "typescript",
      autoStopInterval: 15,
      autoDeleteInterval: -1,
      labels: { app: "symphony", role: "spike-stdio", issue: "SWYRD-wnzgxnsi" },
    },
    { timeout: 300 },
  );
  console.log(`sandbox id=${sandbox.id} state=${sandbox.state}`);

  const sessionId = `spike-stdio-${Date.now()}`;
  await sandbox.process.createSession(sessionId);
  sessionToCleanup = sessionId;

  // bash loop: reads lines from stdin, echoes "echo:<line>" to stdout, exits
  // cleanly on a sentinel. `bash -u` keeps `read` blocking for stdin.
  // `read -r` preserves backslashes.
  const peerCommand = [
    "bash -uc '",
    "echo ready;",
    "while IFS= read -r line; do",
    `  if [ "$line" = "${echoSentinel}" ]; then exit 0; fi;`,
    '  printf "echo:%s\\n" "$line";',
    "done",
    "'",
  ].join(" ");

  const launched = await sandbox.process.executeSessionCommand(sessionId, {
    command: peerCommand,
    runAsync: true,
  });
  if (!launched.cmdId) {
    throw new Error("session command did not return cmdId");
  }
  const commandId = launched.cmdId;
  console.log(`launched session command cmdId=${commandId}`);

  // Start streaming logs in the background. The follow=true WebSocket stays
  // open until the command exits or we kill it.
  const streamPromise = sandbox.process
    .getSessionCommandLogs(
      sessionId,
      commandId,
      (chunk) => {
        stdoutChunks.push({ at: new Date().toISOString(), chunk });
        process.stdout.write(`[stdout] ${chunk}`);
      },
      (chunk) => {
        stderrChunks.push({ at: new Date().toISOString(), chunk });
        process.stderr.write(`[stderr] ${chunk}`);
      },
    )
    .catch((error: unknown) => {
      // The stream ends when the command exits. Don't propagate.
      console.warn(`[stream] closed: ${error instanceof Error ? error.message : String(error)}`);
    });

  // Wait for the "ready" line so we know the loop is past startup and reading
  // from stdin. If the SDK refused to stream at all, this fails fast.
  const ready = await waitFor(
    () => stdoutChunks.some(({ chunk }) => chunk.includes("ready")),
    10_000,
  );
  if (!ready) {
    throw new Error("peer never emitted 'ready'; output stream may be broken");
  }

  for (const [i, raw] of messages.entries()) {
    const expected = `echo:${raw}`;
    const sentAt = new Date().toISOString();
    const start = Date.now();
    await sandbox.process.sendSessionCommandInput(sessionId, commandId, `${raw}\n`);

    const arrived = await waitFor(
      () => stdoutChunks.some(({ chunk }) => chunk.includes(expected)),
      5_000,
    );
    const matchedChunk = stdoutChunks.find(({ chunk }) => chunk.includes(expected));
    const probe: RoundTripProbe = {
      index: i,
      sentAt,
      received: arrived,
      expected,
      ...(matchedChunk && {
        receivedAt: matchedChunk.at,
        elapsedMs: Date.now() - start,
        observed: matchedChunk.chunk,
      }),
    };
    probes.push(probe);
    if (!arrived) {
      throw new Error(`probe ${i} (${raw}) not echoed back within 5s`);
    }
    console.log(`✓ probe ${i} round-trip in ${probe.elapsedMs}ms`);
  }

  // Send the sentinel and wait for the peer to exit (the stream promise
  // resolves when the WebSocket closes).
  await sandbox.process.sendSessionCommandInput(sessionId, commandId, `${echoSentinel}\n`);

  const streamClosed = await Promise.race([
    streamPromise.then(() => true),
    sleep(10_000).then(() => false),
  ]);
  if (!streamClosed) {
    console.warn("stream did not close within 10s after sentinel; continuing");
  }

  const finalCmd = await sandbox.process.getSessionCommand(sessionId, commandId);
  console.log(`final cmd state: exitCode=${finalCmd.exitCode}`);

  if (finalCmd.exitCode !== 0) {
    throw new Error(`peer exited non-zero: ${finalCmd.exitCode}`);
  }
  if (probes.length !== messages.length || !probes.every((p) => p.received)) {
    throw new Error("not all probes round-tripped");
  }

  outcome = "success";
} catch (error) {
  failureReason = error instanceof Error ? error.message : String(error);
  console.error(`spike failed: ${failureReason}`);
} finally {
  if (sandbox && sessionToCleanup) {
    try {
      await sandbox.process.deleteSession(sessionToCleanup);
    } catch (error) {
      console.error(
        `session delete failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (sandbox) {
    try {
      await sandbox.delete();
      deleted = true;
    } catch (error) {
      console.error(
        `sandbox delete failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

const manifest = {
  outcome,
  failureReason,
  completedAt: new Date().toISOString(),
  apiUrl,
  target,
  snapshot: snapshotName,
  sandboxDeleted: deleted,
  approach:
    "Process.executeSessionCommand(runAsync) + sendSessionCommandInput + getSessionCommandLogs(onStdout, onStderr)",
  probes,
  stdoutChunkCount: stdoutChunks.length,
  stderrChunkCount: stderrChunks.length,
};

writeFileSync(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  join(artifactDir, "stdout.log"),
  stdoutChunks.map(({ at, chunk }) => `${at} ${chunk}`).join(""),
);
writeFileSync(
  join(artifactDir, "stderr.log"),
  stderrChunks.map(({ at, chunk }) => `${at} ${chunk}`).join(""),
);

console.log(`\nSpike complete: ${outcome}. Artifacts: ${artifactDir}`);
if (outcome !== "success") {
  process.exit(1);
}
