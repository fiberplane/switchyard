#!/usr/bin/env node
// Driver script copied into the sandbox. Spawns `codex app-server` and drives
// the JSON-RPC handshake over stdio, streams events to transcript.jsonl, and
// auto-approves any approval requests. Exits 0 on turn/completed, non-zero on
// turn/failed, turn/cancelled, request-input, or timeout.

const { spawn } = require("node:child_process");
const { createWriteStream, mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const promptPath = process.env.PROMPT_PATH || "/tmp/prompt.md";
const cwd = process.env.WORKER_CWD || "/workspace/repo";
const codexHome = process.env.CODEX_HOME || "/workspace/codex-home";
const transcriptPath = process.env.TRANSCRIPT_PATH || "/tmp/.symphony/transcript.jsonl";
const stderrPath = process.env.STDERR_PATH || "/tmp/.symphony/codex.stderr.log";
const turnTimeoutMs = Number(process.env.TURN_TIMEOUT_MS || 600_000);
const readTimeoutMs = Number(process.env.READ_TIMEOUT_MS || 60_000);

mkdirSync(dirname(transcriptPath), { recursive: true });
mkdirSync(dirname(stderrPath), { recursive: true });
const transcript = createWriteStream(transcriptPath, { flags: "w" });
const stderrLog = createWriteStream(stderrPath, { flags: "w" });

const promptText = require("node:fs").readFileSync(promptPath, "utf8");

const env = { ...process.env, CODEX_HOME: codexHome };
delete env.OPENAI_API_KEY;
delete env.SANDBOX_OPENAI_API_KEY;

const proc = spawn("bash", ["-lc", "codex app-server"], {
  cwd,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

proc.stderr.on("data", (chunk) => {
  stderrLog.write(chunk);
});

const writeMessage = (msg) => {
  const line = `${JSON.stringify(msg)}\n`;
  proc.stdin.write(line);
};

const recordEvent = (direction, msg) => {
  transcript.write(`${JSON.stringify({ ts: new Date().toISOString(), direction, msg })}\n`);
};

let buffer = "";
let nextRequestId = 1;
const allocateRequestId = () => nextRequestId++;
const pending = new Map();

let resolved = false;
const finish = (status, detail) => {
  if (resolved) {
    return;
  }
  resolved = true;
  const finalState = { status, detail, completedAt: new Date().toISOString() };
  writeFileSync("/tmp/.symphony/driver-final.json", `${JSON.stringify(finalState, null, 2)}\n`);
  try {
    proc.stdin.end();
  } catch {}
  setTimeout(() => {
    try {
      proc.kill();
    } catch {}
    process.exit(status === "turn_completed" ? 0 : 1);
  }, 1500).unref();
};

setTimeout(() => finish("turn_timeout", { turnTimeoutMs }), turnTimeoutMs).unref();

const handleMessage = (msg) => {
  recordEvent("recv", msg);

  if (msg.id !== undefined && pending.has(msg.id)) {
    const { method, resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      reject(new Error(`${method} failed: [${msg.error.code}] ${msg.error.message}`));
    } else {
      resolve(msg.result);
    }
    return;
  }

  // Notifications / streamed events
  switch (msg.method) {
    case "turn/completed":
      finish("turn_completed", { params: msg.params ?? null });
      return;
    case "turn/failed":
      finish("turn_failed", {
        reason: msg.params?.error || msg.params?.message || "turn/failed",
      });
      return;
    case "turn/cancelled":
      finish("turn_cancelled", { reason: msg.params?.reason || "cancelled" });
      return;
    case "item/tool/requestUserInput":
      finish("turn_input_required", { prompt: msg.params?.prompt });
      return;
    default:
      break;
  }

  // Auto-approve any approval-style server requests (defense-in-depth even with policy=never)
  if (msg.id !== undefined && typeof msg.method === "string") {
    const m = msg.method;
    let result = null;
    if (m === "applyPatchApproval" || m === "item/fileChange/requestApproval") {
      result = { decision: "approved" };
    } else if (m === "execCommandApproval" || m === "item/commandExecution/requestApproval") {
      result = { decision: "approved" };
    } else if (m === "item/permissions/requestApproval") {
      result = { decision: "approved" };
    }
    if (result) {
      const reply = { id: msg.id, result };
      recordEvent("send", reply);
      writeMessage(reply);
    }
  }
};

proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      recordEvent("parse_error", { line: line.slice(0, 500), error: String(err) });
      continue;
    }
    handleMessage(parsed);
  }
});

proc.on("exit", (code, signal) => {
  if (!resolved) {
    finish("process_exit", { code, signal });
  }
});

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = allocateRequestId();
    pending.set(id, { method, resolve, reject });
    const msg = { id, method, params };
    recordEvent("send", msg);
    writeMessage(msg);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${readTimeoutMs}ms`));
      }
    }, readTimeoutMs).unref();
  });

(async () => {
  try {
    await request("initialize", {
      clientInfo: { name: "switchyard-smoke", version: "0.1", title: "Switchyard Smoke" },
      capabilities: {},
    });
    // No "initialized" notification expected by the codex app-server.

    const threadResult = await request("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
    });
    const threadId = threadResult?.thread?.id || threadResult?.threadId || null;
    if (!threadId) {
      finish("thread_start_no_id", { result: threadResult });
      return;
    }

    const turnId = allocateRequestId();
    const turnMsg = {
      id: turnId,
      method: "turn/start",
      params: {
        threadId,
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        input: [{ type: "text", text: promptText }],
      },
    };
    recordEvent("send", turnMsg);
    writeMessage(turnMsg);
    pending.set(turnId, {
      method: "turn/start",
      resolve: () => {},
      reject: (err) => finish("turn_start_rejected", { error: err.message }),
    });
  } catch (err) {
    finish("handshake_failed", { error: err instanceof Error ? err.message : String(err) });
  }
})();
