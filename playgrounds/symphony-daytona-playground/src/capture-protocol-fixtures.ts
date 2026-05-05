// Capture script for SWYRD-dhkyapwn: records frame-by-frame send/recv data
// from a real local `codex app-server` session and emits JSONL fixtures the
// runner-transport tests will replay.
//
// Spawns codex app-server LOCALLY (not in Daytona). Local spawn is enough for
// fixture capture; the protocol bytes are identical to what production drives
// over the Daytona session.
//
// Usage:
//   bun run src/capture-protocol-fixtures.ts                    # capture all variants
//   bun run src/capture-protocol-fixtures.ts happy-path
//   bun run src/capture-protocol-fixtures.ts approval-roundtrip
//
// Output: writes <variant>.jsonl + <variant>.meta.json under
// FIXTURE_OUT_DIR (default: apps/symphony-orchestrator/test/runner/fixtures/).

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface VariantSpec {
  readonly name: string;
  readonly prompt: string;
  readonly threadStartParams: Record<string, unknown>;
  readonly turnStartExtras: Record<string, unknown>;
  readonly note: string;
}

interface CapturedFrame {
  readonly ts: string;
  readonly direction: "send" | "recv";
  readonly message: unknown;
}

interface VariantResult {
  readonly name: string;
  readonly fixturePath: string;
  readonly metaPath: string;
  readonly frames: CapturedFrame[];
  readonly approvalRequestCount: number;
  readonly finalNotification: string | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const DEFAULT_FIXTURE_DIR = join(
  REPO_ROOT,
  "apps",
  "symphony-orchestrator",
  "test",
  "runner",
  "fixtures",
);
const fixtureDir = process.env.FIXTURE_OUT_DIR
  ? resolve(process.env.FIXTURE_OUT_DIR)
  : DEFAULT_FIXTURE_DIR;

const codexAuthPath = process.env.CODEX_AUTH_JSON || `${process.env.HOME}/.codex/auth.json`;
if (!existsSync(codexAuthPath)) {
  throw new Error(`Codex auth file not found at ${codexAuthPath}`);
}

const codexBin = process.env.CODEX_BIN || "codex";
const codexVersion = execFileSync(codexBin, ["--version"], { encoding: "utf8" }).trim();

// Per-variant timeout for the whole turn (codex can be slow on first call).
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 180_000);
// Per-request timeout for handshake calls (initialize, thread/start).
const READ_TIMEOUT_MS = Number(process.env.READ_TIMEOUT_MS || 60_000);

const variants: Record<string, VariantSpec> = {
  "happy-path": {
    name: "happy-path-turn",
    // Trivial reply-only prompt: no tool calls, no approval requests, clean
    // turn/completed. Capturing this exercises the framing layer against a
    // pure initialize → thread/start → turn/start → streamed items →
    // turn/completed sequence with no server-initiated requests.
    prompt: "Respond with only the single word DONE and nothing else.",
    threadStartParams: {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
    },
    turnStartExtras: {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
    note: "trivial prompt; no tool calls expected",
  },
  "approval-roundtrip": {
    name: "approval-roundtrip",
    // read-only sandbox + on-request approval forces codex to escalate any
    // file write through the approval pipeline. We prompt it to create a
    // file, which triggers either applyPatchApproval or
    // item/fileChange/requestApproval depending on codex-cli version.
    // The capture script auto-approves and lets the turn finish.
    prompt:
      "Create a new file named hello.txt in the current directory with the exact content 'hi' (no newline). Then reply with the single word DONE.",
    threadStartParams: {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      ephemeral: true,
    },
    turnStartExtras: {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
    note: "file-write prompt against read-only sandbox; approval auto-approved",
  },
};

const APPROVAL_METHODS = new Set([
  "applyPatchApproval",
  "execCommandApproval",
  "item/fileChange/requestApproval",
  "item/commandExecution/requestApproval",
  "item/permissions/requestApproval",
]);

const TERMINAL_NOTIFICATIONS = new Set([
  "turn/completed",
  "thread/turn/completed",
  "turn/failed",
  "thread/turn/failed",
  "turn/cancelled",
  "thread/turn/cancelled",
  "item/tool/requestUserInput",
]);

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const captureVariant = async (variantKey: string): Promise<VariantResult> => {
  const variant = variants[variantKey];
  if (!variant) {
    throw new Error(`unknown variant: ${variantKey}`);
  }

  // Tiny throwaway git repo to use as cwd. codex requires a real working
  // directory; an empty repo keeps the prompt cheap and the trace short.
  const root = mkdtempSync(join(tmpdir(), `codex-fixture-${variant.name}-`));
  const repoDir = join(root, "repo");
  const codexHome = join(root, "codex-home");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  copyFileSync(codexAuthPath, join(codexHome, "auth.json"));
  chmodSync(join(codexHome, "auth.json"), 0o600);
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Fixture Capture"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# fixture repo\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repoDir });

  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  delete env.OPENAI_API_KEY;
  delete env.SANDBOX_OPENAI_API_KEY;

  const proc = spawn(codexBin, ["app-server"], {
    cwd: repoDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const frames: CapturedFrame[] = [];
  let approvalRequestCount = 0;
  let finalNotification: string | null = null;

  // Stream codex stderr straight through; on failure it's the only signal
  // that explains why the turn never completed.
  proc.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  let nextRequestId = 1;
  const allocateRequestId = () => nextRequestId++;
  const pending = new Map<
    number,
    {
      readonly method: string;
      readonly resolve: (result: unknown) => void;
      readonly reject: (err: Error) => void;
    }
  >();

  let resolved = false;
  let turnDonePromiseResolve: () => void = () => {};
  const turnDonePromise = new Promise<void>((resolve) => {
    turnDonePromiseResolve = resolve;
  });

  const recordSend = (msg: unknown) => {
    frames.push({ ts: new Date().toISOString(), direction: "send", message: msg });
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  const recordRecv = (msg: unknown) => {
    frames.push({ ts: new Date().toISOString(), direction: "recv", message: msg });
  };

  const finish = (label: string) => {
    if (resolved) {
      return;
    }
    resolved = true;
    finalNotification = label;
    turnDonePromiseResolve();
  };

  const handleMessage = (msg: {
    id?: unknown;
    method?: unknown;
    result?: unknown;
    error?: unknown;
    params?: unknown;
  }) => {
    recordRecv(msg);

    // Response to a previously-sent request
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      if (!entry) {
        return;
      }
      pending.delete(msg.id);
      if (msg.error) {
        const errMsg =
          typeof (msg.error as { message?: unknown }).message === "string"
            ? (msg.error as { message: string }).message
            : JSON.stringify(msg.error);
        entry.reject(new Error(`${entry.method} failed: ${errMsg}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Server-initiated approval requests — auto-approve so the turn proceeds.
    // The decision payload differs by method:
    //   - legacy applyPatchApproval / execCommandApproval use ReviewDecision
    //     ("approved" | "denied" | ...).
    //   - v2 item/{fileChange,commandExecution}/requestApproval use the
    //     accept/decline/cancel enum.
    //   - v2 item/permissions/requestApproval uses a granted-profile shape;
    //     we just decline to keep the response well-typed.
    if (
      typeof msg.id === "number" &&
      typeof msg.method === "string" &&
      APPROVAL_METHODS.has(msg.method)
    ) {
      approvalRequestCount += 1;
      let result: unknown;
      if (msg.method === "applyPatchApproval" || msg.method === "execCommandApproval") {
        result = { decision: "approved" };
      } else if (
        msg.method === "item/fileChange/requestApproval" ||
        msg.method === "item/commandExecution/requestApproval"
      ) {
        result = { decision: "accept" };
      } else if (msg.method === "item/permissions/requestApproval") {
        // Decline — granting requires constructing a GrantedPermissionProfile.
        // The runner-transport tests only need the reply byte shape; cancel
        // here is enough to provoke the server's resolution path.
        result = { decision: "decline" };
      } else {
        result = { decision: "accept" };
      }
      const reply = { id: msg.id, result };
      recordSend(reply);
      return;
    }

    // Notifications
    if (typeof msg.method === "string" && TERMINAL_NOTIFICATIONS.has(msg.method)) {
      finish(msg.method);
    }
  };

  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          handleMessage(
            parsed as {
              id?: unknown;
              method?: unknown;
              result?: unknown;
              error?: unknown;
              params?: unknown;
            },
          );
        }
      } catch (err) {
        // Surface parse errors as recv frames so the fixture preserves the
        // raw bytes — the framing layer's job is to reject malformed input.
        recordRecv({ __parseError: String(err), raw: line.slice(0, 500) });
      }
    }
  });

  proc.on("exit", (code, signal) => {
    if (!resolved) {
      finish(`$processExit code=${code ?? "?"} signal=${signal ?? "?"}`);
    }
  });

  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolveReq, rejectReq) => {
      const id = allocateRequestId();
      pending.set(id, { method, resolve: resolveReq, reject: rejectReq });
      recordSend({ id, method, params });
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rejectReq(new Error(`${method} timed out after ${READ_TIMEOUT_MS}ms`));
        }
      }, READ_TIMEOUT_MS);
      timer.unref();
    });

  const turnTimer = setTimeout(() => {
    if (!resolved) {
      finish("$captureTimeout");
    }
  }, TURN_TIMEOUT_MS);
  turnTimer.unref();

  try {
    await request("initialize", {
      clientInfo: {
        name: "switchyard-fixture-capture",
        version: "0.1",
        title: "Switchyard Fixture Capture",
      },
      capabilities: {},
    });

    const threadResult = (await request("thread/start", {
      cwd: repoDir,
      ...variant.threadStartParams,
    })) as { thread?: { id?: string }; threadId?: string };
    const threadId = threadResult?.thread?.id ?? threadResult?.threadId;
    if (!threadId) {
      throw new Error(`thread/start returned no thread id: ${JSON.stringify(threadResult)}`);
    }

    // turn/start: send and forget. The synchronous JSON-RPC response is just
    // the acknowledgement; the work arrives as streamed item events and a
    // terminal turn/completed (or turn/failed) notification. We don't
    // register the id in `pending` so the response is captured as a normal
    // recv frame without a phantom resolver waiting on it.
    const turnId = allocateRequestId();
    recordSend({
      id: turnId,
      method: "turn/start",
      params: {
        threadId,
        cwd: repoDir,
        input: [{ type: "text", text: variant.prompt }],
        ...variant.turnStartExtras,
      },
    });

    await turnDonePromise;
  } finally {
    try {
      proc.stdin.end();
    } catch {
      // ignore
    }
    // Give the process a moment to flush before killing.
    await sleep(250);
    try {
      proc.kill();
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true });
  }

  const fixturePath = join(fixtureDir, `${variant.name}.jsonl`);
  const metaPath = join(fixtureDir, `${variant.name}.meta.json`);

  return {
    name: variant.name,
    fixturePath,
    metaPath,
    frames,
    approvalRequestCount,
    finalNotification,
  };
};

const writeFixture = (variantKey: string, result: VariantResult) => {
  const variant = variants[variantKey];
  if (!variant) {
    throw new Error(`unknown variant: ${variantKey}`);
  }
  mkdirSync(dirname(result.fixturePath), { recursive: true });

  const jsonl = result.frames.map((frame) => JSON.stringify(frame)).join("\n");
  writeFileSync(result.fixturePath, `${jsonl}\n`);

  const sendCount = result.frames.filter((f) => f.direction === "send").length;
  const recvCount = result.frames.filter((f) => f.direction === "recv").length;
  const meta = {
    variant: variant.name,
    note: variant.note,
    capturedAt: new Date().toISOString(),
    codexCliVersion: codexVersion,
    prompt: variant.prompt,
    threadStartParams: variant.threadStartParams,
    turnStartExtras: variant.turnStartExtras,
    totalFrames: result.frames.length,
    sendFrames: sendCount,
    recvFrames: recvCount,
    approvalRequestCount: result.approvalRequestCount,
    finalNotification: result.finalNotification,
  };
  writeFileSync(result.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
};

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : Object.keys(variants);
console.log(`codex-cli version: ${codexVersion}`);
console.log(`fixture dir: ${fixtureDir}`);
console.log(`variants: ${targets.join(", ")}`);

for (const key of targets) {
  if (!variants[key]) {
    throw new Error(`unknown variant: ${key} (known: ${Object.keys(variants).join(", ")})`);
  }
  console.log(`\n== capturing ${key} ==`);
  const result = await captureVariant(key);
  writeFixture(key, result);
  console.log(
    `  frames=${result.frames.length} send=${result.frames.filter((f) => f.direction === "send").length} recv=${result.frames.filter((f) => f.direction === "recv").length} approvals=${result.approvalRequestCount} final=${result.finalNotification}`,
  );
  console.log(`  wrote ${result.fixturePath}`);
  console.log(`  wrote ${result.metaPath}`);
  // The approval-roundtrip fixture is only useful if it actually contains
  // server-initiated approval requests. If codex did not escalate (e.g.
  // because the model declined to attempt the disallowed write), the
  // captured fixture is silently misleading — fail loudly instead of
  // overwriting the committed fixture with a degenerate one.
  if (key === "approval-roundtrip" && result.approvalRequestCount === 0) {
    console.error(
      "  ERROR: approval-roundtrip variant captured zero approval requests; the prompt or policy may need adjustment.",
    );
    process.exitCode = 1;
  }
}
