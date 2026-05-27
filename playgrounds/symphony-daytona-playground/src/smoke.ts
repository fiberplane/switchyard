import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Daytona } from "@daytona/sdk";
import type {} from "bun";

interface CommandEvidence {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
}

interface HostProbe {
  readonly candidate: string;
  readonly ok: boolean;
  readonly output: string;
}

const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
const root = mkdtempSync(join(tmpdir(), "symphony-daytona-smoke-"));
const localRepo = join(root, "repo");
const artifactDir = join(process.cwd(), "artifacts", `pjy-smoke-${timestamp}`);
const remoteRepo = "/workspace/repo";
const remoteCodexHome = "/workspace/codex-home";
const remotePrompt = "/tmp/prompt.md";
const remoteArchive = "/tmp/repo.tgz";
const remoteAuth = "/tmp/codex-auth.json";
const expectedMessage = "hello from daytona codex worker";
const artifactFiles = [
  "symphony-result.patch",
  "symphony-result.json",
  "symphony-result.diffstat",
  "codex-events.jsonl",
  "codex-last-message.txt",
  "host-probes.json",
  "prompt.md",
  "repo.tgz",
];

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

const sh = (command: string, cwd = root) =>
  execFileSync("bash", ["-lc", command], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const sq = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

const run = async (name: string, command: string, timeout = 120): Promise<CommandEvidence> => {
  console.log(`\n== ${name} ==`);
  const result = await sandbox!.process.executeCommand(command, undefined, undefined, timeout);
  console.log(result.result);
  if (result.exitCode !== 0) {
    throw new Error(`${name} failed with exit ${result.exitCode}`);
  }
  return { name, command, exitCode: result.exitCode, stdout: result.result };
};

const startHostServer = async () => {
  const token = `host-ok-${Date.now()}`;
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(token);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("host server did not expose a TCP address");
  }

  return { server, port: address.port, token };
};

const getHostCandidates = () => {
  const candidates = new Set(["host.docker.internal", "172.17.0.1"]);

  try {
    for (const ip of sh("hostname -I || true")
      .trim()
      .split(/\s+/)
      .filter((value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value))) {
      candidates.add(ip);
    }
  } catch {}

  return [...candidates];
};

const writeTinyRepo = () => {
  mkdirSync(localRepo, { recursive: true });
  writeFileSync(
    join(localRepo, "package.json"),
    JSON.stringify(
      {
        name: "pjy-daytona-smoke-repo",
        private: true,
        type: "module",
        scripts: { test: "node test.js" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(localRepo, "message.txt"), "before codex\n");
  writeFileSync(
    join(localRepo, "test.js"),
    `import { readFileSync } from "node:fs";

const message = readFileSync("message.txt", "utf8").trim();
if (message !== ${JSON.stringify(expectedMessage)}) {
  throw new Error(\`unexpected message: \${message}\`);
}
console.log("repo smoke test passed");
`,
  );
  writeFileSync(join(localRepo, "README.md"), "# Daytona Smoke Repo\n");
  sh(`tar -czf ${sq(join(root, "repo.tgz"))} -C ${sq(localRepo)} .`);
};

const writePrompt = () => {
  const prompt = `You are running inside a Daytona sandbox for a Switchyard smoke test.

In /workspace/repo, edit message.txt so its entire contents are exactly:
${expectedMessage}

Then run:
node test.js

Do not change package.json. Keep the final response brief.`;

  writeFileSync(join(root, "prompt.md"), prompt);
};

const writeManifest = (manifest: unknown) => {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
};

const apiKey = getRequired("DAYTONA_API_KEY", process.env.DAYTONA_API_KEY_FILE);
const apiUrl = process.env.DAYTONA_API_URL;
const target = process.env.DAYTONA_TARGET;
const snapshotName = process.env.DAYTONA_SNAPSHOT || "symphony-codex-bun";
const codexAuthPath = process.env.CODEX_AUTH_JSON || `${process.env.HOME}/.codex/auth.json`;

if (!existsSync(codexAuthPath)) {
  throw new Error(`Codex auth file not found: ${codexAuthPath}`);
}

writeTinyRepo();
writePrompt();
mkdirSync(artifactDir, { recursive: true });
chmodSync(artifactDir, 0o700);

const hostServer = await startHostServer();
let sandbox: Awaited<ReturnType<Daytona["create"]>> | undefined;
const commandEvidence: CommandEvidence[] = [];
const streamedChunks: string[] = [];
let hostProbes: HostProbe[] = [];
let deleted = false;

console.log(`artifactDir=${artifactDir}`);
console.log(`apiUrl=${apiUrl ?? "<sdk-default>"}`);
console.log(`target=${target ?? "<sdk-default>"}`);
console.log(`snapshot=${snapshotName}`);
console.log(`hostPort=${hostServer.port}`);

const daytona = new Daytona({
  apiKey,
  ...(apiUrl ? { apiUrl } : {}),
  ...(target ? { target } : {}),
});

try {
  const snapshot = await daytona.snapshot.get(snapshotName);
  if (snapshot.state !== "active") {
    throw new Error(`Snapshot ${snapshotName} is ${snapshot.state}, not active`);
  }

  const createSandbox = () =>
    daytona.create(
      {
        name: `pjy-smoke-${Date.now()}`,
        snapshot: snapshotName,
        language: "typescript",
        autoStopInterval: 15,
        autoDeleteInterval: -1,
        envVars: {
          SYMPHONY_ISSUE_ID: "pjy",
          SYMPHONY_ISSUE_DISPLAY_ID: "SWYRD-pjysttqi",
        },
        labels: {
          app: "symphony",
          issue: "pjy",
          role: "codex-runner-smoke",
        },
      },
      { timeout: 300 },
    );

  sandbox = await createSandbox();

  console.log(`sandbox id=${sandbox.id} name=${sandbox.name} state=${sandbox.state}`);

  await sandbox.fs.uploadFiles([
    { source: join(root, "repo.tgz"), destination: remoteArchive },
    { source: join(root, "prompt.md"), destination: remotePrompt },
    { source: codexAuthPath, destination: remoteAuth },
  ]);

  commandEvidence.push(
    await run(
      "setup repo and base git state",
      [
        "set -euxo pipefail",
        `rm -rf ${sq(remoteRepo)} ${sq(remoteCodexHome)}`,
        `mkdir -p ${sq(remoteRepo)} ${sq(remoteCodexHome)}`,
        `tar -xzf ${sq(remoteArchive)} -C ${sq(remoteRepo)}`,
        `cp ${sq(remoteAuth)} ${sq(`${remoteCodexHome}/auth.json`)}`,
        `chmod 600 ${sq(`${remoteCodexHome}/auth.json`)}`,
        'git config --global user.name "Switchyard Smoke"',
        'git config --global user.email "switchyard-smoke@example.invalid"',
        `git config --global --add safe.directory ${sq(remoteRepo)}`,
        `cd ${sq(remoteRepo)}`,
        "git init",
        "git add .",
        'git commit -m "base"',
        "git tag symphony-base",
        "git status --short",
      ].join("\n"),
    ),
  );

  commandEvidence.push(
    await run(
      "tool and auth check",
      [
        "set -euxo pipefail",
        "git --version",
        "node --version",
        "npm --version",
        "bun --version",
        "codex --version",
        `CODEX_HOME=${sq(remoteCodexHome)} codex login status`,
      ].join("\n"),
    ),
  );

  const sessionId = `pjy-stream-${Date.now()}`;
  await sandbox.process.createSession(sessionId);
  const streamCommand = await sandbox.process.executeSessionCommand(sessionId, {
    command: 'for i in 1 2 3; do echo "stream-log-$i"; sleep 1; done',
    runAsync: true,
  });
  if (!streamCommand.cmdId) {
    throw new Error("stream command did not return cmdId");
  }
  await sandbox.process.getSessionCommandLogs(
    sessionId,
    streamCommand.cmdId,
    (chunk) => {
      streamedChunks.push(chunk);
      process.stdout.write(`[stream stdout] ${chunk}`);
    },
    (chunk) => {
      streamedChunks.push(chunk);
      process.stderr.write(`[stream stderr] ${chunk}`);
    },
  );
  const streamLogs = await sandbox.process.getSessionCommandLogs(sessionId, streamCommand.cmdId);
  await sandbox.process.deleteSession(sessionId);
  commandEvidence.push({
    name: "streamed session logs",
    command: "for i in 1 2 3; do echo stream-log-$i; sleep 1; done",
    exitCode: 0,
    stdout: streamLogs.stdout || streamLogs.output || "",
  });

  const initialCandidates = getHostCandidates();
  const sandboxGateway = await sandbox.process.executeCommand(
    "command -v ip >/dev/null 2>&1 && ip -4 route show default | awk '{print $3}' | head -n1 || true",
  );
  const candidates = [
    ...new Set([...initialCandidates, sandboxGateway.result.trim()].filter(Boolean)),
  ];
  const candidateArgs = candidates.map(sq).join(" ");
  const hostProbeCommand = [
    "set -uo pipefail",
    "printf '[' > /tmp/host-probes.json",
    "first=1",
    `for candidate in ${candidateArgs}; do`,
    `  output=$(curl -fsS --max-time 4 "http://$candidate:${hostServer.port}/health" 2>&1)`,
    "  status=$?",
    "  if [ $first -eq 0 ]; then printf ',' >> /tmp/host-probes.json; fi",
    "  first=0",
    '  jq -n --arg candidate "$candidate" --arg output "$output" --argjson ok "$([ $status -eq 0 ] && echo true || echo false)" \'{candidate:$candidate,ok:$ok,output:$output}\' >> /tmp/host-probes.json',
    "done",
    "printf ']' >> /tmp/host-probes.json",
    "cat /tmp/host-probes.json",
  ].join("\n");
  const hostProbe = await run("host reachability probe", hostProbeCommand);
  hostProbes = JSON.parse(hostProbe.stdout) as HostProbe[];
  commandEvidence.push(hostProbe);

  if (!hostProbes.some((probe) => probe.ok && probe.output === hostServer.token)) {
    throw new Error(
      `No sandbox-to-host candidate reached the host server token ${hostServer.token}`,
    );
  }

  commandEvidence.push(
    await run(
      "codex edit",
      [
        "set -euxo pipefail",
        `cd ${sq(remoteRepo)}`,
        `CODEX_HOME=${sq(remoteCodexHome)} codex exec --json --dangerously-bypass-approvals-and-sandbox --cd ${sq(remoteRepo)} --output-last-message /tmp/codex-last-message.txt - < ${sq(remotePrompt)} > /tmp/codex-events.jsonl`,
      ].join("\n"),
      900,
    ),
  );

  commandEvidence.push(
    await run(
      "shell check and artifact generation",
      [
        "set -euxo pipefail",
        `cd ${sq(remoteRepo)}`,
        "node test.js",
        "git status --short",
        "git diff --binary symphony-base > /tmp/symphony-result.patch",
        "git diff --stat symphony-base > /tmp/symphony-result.diffstat",
        "git diff --name-only symphony-base > /tmp/symphony-result.files",
        "node - <<'NODE' > /tmp/symphony-result.json",
        "const { readFileSync } = require('node:fs');",
        "const result = {",
        "  status: 'success',",
        "  message: readFileSync('message.txt', 'utf8').trim(),",
        "  changedFiles: readFileSync('/tmp/symphony-result.files', 'utf8').trim().split('\\n').filter(Boolean),",
        "  diffstat: readFileSync('/tmp/symphony-result.diffstat', 'utf8').trim(),",
        "};",
        "process.stdout.write(JSON.stringify(result, null, 2) + '\\n');",
        "NODE",
        "cat /tmp/symphony-result.json",
      ].join("\n"),
    ),
  );

  await sandbox.fs.downloadFiles([
    {
      source: "/tmp/symphony-result.patch",
      destination: join(artifactDir, "symphony-result.patch"),
    },
    { source: "/tmp/symphony-result.json", destination: join(artifactDir, "symphony-result.json") },
    {
      source: "/tmp/symphony-result.diffstat",
      destination: join(artifactDir, "symphony-result.diffstat"),
    },
    { source: "/tmp/codex-events.jsonl", destination: join(artifactDir, "codex-events.jsonl") },
    {
      source: "/tmp/codex-last-message.txt",
      destination: join(artifactDir, "codex-last-message.txt"),
    },
    { source: "/tmp/host-probes.json", destination: join(artifactDir, "host-probes.json") },
  ]);

  cpSync(join(root, "prompt.md"), join(artifactDir, "prompt.md"));
  cpSync(join(root, "repo.tgz"), join(artifactDir, "repo.tgz"));

  writeManifest({
    status: "success",
    createdAt: new Date().toISOString(),
    apiUrl,
    target,
    snapshot: snapshotName,
    sandbox: { id: sandbox.id, name: sandbox.name },
    hostServer: { port: hostServer.port },
    hostReachability: hostProbes,
    streamedLogChunks: streamedChunks,
    commands: commandEvidence.map(({ name, command, exitCode }) => ({ name, command, exitCode })),
    artifacts: artifactFiles.map((file) => join(artifactDir, file)),
  });
} finally {
  await new Promise<void>((resolve) => (hostServer.server as Server).close(() => resolve()));
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

writeManifest({
  status: deleted ? "success" : "success-delete-unconfirmed",
  completedAt: new Date().toISOString(),
  apiUrl,
  target,
  snapshot: snapshotName,
  sandboxDeleted: deleted,
  hostReachability: hostProbes,
  streamedLogChunks: streamedChunks,
  commands: commandEvidence.map(({ name, command, exitCode }) => ({ name, command, exitCode })),
  artifactDir,
  artifacts: artifactFiles.map((file) => join(artifactDir, file)),
});

console.log(`\nSmoke complete. Artifacts: ${artifactDir}`);
