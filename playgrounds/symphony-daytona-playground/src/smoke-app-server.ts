import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Daytona } from "@daytona/sdk";
import type {} from "bun";
import { Effect, Schema } from "effect";

interface CommandEvidence {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
}

// Mirrors WorkerOutcome from docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md.
const WorkerOutcome = Schema.Struct({
  status: Schema.Literal("completed", "blocked", "needs-human", "failed"),
  summary: Schema.String,
});
type WorkerOutcomeT = Schema.Schema.Type<typeof WorkerOutcome>;

const HERE = dirname(fileURLToPath(import.meta.url));
const driverCandidates = [
  resolve(HERE, "codex-driver.cjs"),
  resolve(HERE, "..", "src", "codex-driver.cjs"),
  resolve(process.cwd(), "src", "codex-driver.cjs"),
];
const driverSource = driverCandidates.find((p) => existsSync(p));
if (!driverSource) {
  throw new Error(`driver source not found in: ${driverCandidates.join(", ")}`);
}

const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
const root = mkdtempSync(join(tmpdir(), "symphony-smoke-app-server-"));
const localRepo = join(root, "repo");
const artifactDir = join(process.cwd(), "artifacts", `app-server-${timestamp}`);
const remoteRepo = "/workspace/repo";
const remoteCodexHome = "/workspace/codex-home";
const remotePrompt = "/tmp/prompt.md";
const remoteArchive = "/tmp/repo.tgz";
const remoteAuth = "/tmp/codex-auth.json";
const remoteDriver = "/tmp/codex-driver.cjs";
const remoteSymphonyDir = "/tmp/.symphony";
const remoteTranscript = `${remoteSymphonyDir}/transcript.jsonl`;
const remoteOutcome = `${remoteSymphonyDir}/outcome.json`;
const remoteBundle = `${remoteSymphonyDir}/work.bundle`;
const remoteFullBundle = `${remoteSymphonyDir}/work-full.bundle`;
const remoteStderr = `${remoteSymphonyDir}/codex.stderr.log`;
const expectedMessage = "hello from daytona codex worker";

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

const writeTinyRepo = () => {
  mkdirSync(localRepo, { recursive: true });
  writeFileSync(
    join(localRepo, "package.json"),
    `${JSON.stringify(
      {
        name: "switchyard-app-server-smoke",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(localRepo, "message.txt"), "before codex\n");
  writeFileSync(join(localRepo, "README.md"), "# App-server smoke repo\n");
  sh(`tar -czf ${sq(join(root, "repo.tgz"))} -C ${sq(localRepo)} .`);
};

const writePrompt = () => {
  const prompt = `You are running inside a Daytona sandbox for a Switchyard end-to-end smoke test.

Work in /workspace/repo.

1. Open message.txt and replace its entire contents with exactly:
${expectedMessage}
2. Stage and commit the change with: git add -A && git commit -m "smoke: rewrite message"
3. Write the file /tmp/.symphony/outcome.json with this exact JSON shape and no extra fields.
   The status MUST be one of: "completed", "blocked", "needs-human", "failed".
   For this task, expected on success:
{"status":"completed","summary":"<short one-line summary of what you did>"}

Keep your final assistant message brief (one sentence). Do not modify package.json or README.md.`;
  writeFileSync(join(root, "prompt.md"), prompt);
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

console.log(`artifactDir=${artifactDir}`);
console.log(`apiUrl=${apiUrl ?? "<sdk-default>"}`);
console.log(`target=${target ?? "<sdk-default>"}`);
console.log(`snapshot=${snapshotName}`);

const daytona = new Daytona({
  apiKey,
  ...(apiUrl ? { apiUrl } : {}),
  ...(target ? { target } : {}),
});

let sandbox: Awaited<ReturnType<Daytona["create"]>> | undefined;
const evidence: CommandEvidence[] = [];
let deleted = false;
let outcome: WorkerOutcomeT | { decodeError: string; raw: string } | null = null;
let driverFinal: unknown = null;
let bundleVerified = false;
let hostBranch: string | null = null;

const run = async (name: string, command: string, timeout = 180): Promise<CommandEvidence> => {
  console.log(`\n== ${name} ==`);
  if (!sandbox) {
    throw new Error("sandbox not created");
  }
  const result = await sandbox.process.executeCommand(command, undefined, undefined, timeout);
  if (result.result) {
    process.stdout.write(result.result);
    if (!result.result.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
  if (result.exitCode !== 0) {
    throw new Error(`${name} failed with exit ${result.exitCode}`);
  }
  return { name, command, exitCode: result.exitCode, stdout: result.result ?? "" };
};

try {
  const snapshot = await daytona.snapshot.get(snapshotName);
  if (snapshot.state !== "active") {
    throw new Error(`Snapshot ${snapshotName} is ${snapshot.state}, not active`);
  }

  const createSandbox = () =>
    daytona.create(
      {
        name: `gx-app-server-${Date.now()}`,
        snapshot: snapshotName,
        language: "typescript",
        autoStopInterval: 15,
        autoDeleteInterval: -1,
        envVars: {
          SYMPHONY_ISSUE_ID: "gx",
          SYMPHONY_ISSUE_DISPLAY_ID: "SWYRD-gxgqehxl",
        },
        labels: { app: "symphony", issue: "gx", role: "app-server-smoke" },
      },
      { timeout: 300 },
    );

  sandbox = await createSandbox();

  console.log(`sandbox id=${sandbox.id} name=${sandbox.name} state=${sandbox.state}`);

  await sandbox.fs.uploadFiles([
    { source: join(root, "repo.tgz"), destination: remoteArchive },
    { source: join(root, "prompt.md"), destination: remotePrompt },
    { source: codexAuthPath, destination: remoteAuth },
    { source: driverSource, destination: remoteDriver },
  ]);

  evidence.push(
    await run(
      "stage repo + auth",
      [
        "set -euxo pipefail",
        `rm -rf ${sq(remoteRepo)} ${sq(remoteCodexHome)} ${sq(remoteSymphonyDir)}`,
        `mkdir -p ${sq(remoteRepo)} ${sq(remoteCodexHome)} ${sq(remoteSymphonyDir)}`,
        `tar -xzf ${sq(remoteArchive)} -C ${sq(remoteRepo)}`,
        `cp ${sq(remoteAuth)} ${sq(`${remoteCodexHome}/auth.json`)}`,
        `chmod 700 ${sq(remoteCodexHome)}`,
        `chmod 600 ${sq(`${remoteCodexHome}/auth.json`)}`,
        'git config --global user.name "Switchyard Smoke"',
        'git config --global user.email "switchyard-smoke@example.invalid"',
        `git config --global --add safe.directory ${sq(remoteRepo)}`,
        `cd ${sq(remoteRepo)}`,
        "git init -q",
        "git add .",
        'git commit -q -m "base"',
        "git tag symphony-base",
        "git log --oneline",
      ].join("\n"),
    ),
  );

  evidence.push(
    await run(
      "tool versions + codex login status",
      [
        "set -euxo pipefail",
        "node --version",
        "codex --version",
        `CODEX_HOME=${sq(remoteCodexHome)} codex login status`,
      ].join("\n"),
    ),
  );

  evidence.push(
    await run(
      "drive codex app-server",
      [
        "set -uo pipefail",
        `export CODEX_HOME=${sq(remoteCodexHome)}`,
        `export PROMPT_PATH=${sq(remotePrompt)}`,
        `export WORKER_CWD=${sq(remoteRepo)}`,
        `export TRANSCRIPT_PATH=${sq(remoteTranscript)}`,
        `export STDERR_PATH=${sq(remoteStderr)}`,
        "export TURN_TIMEOUT_MS=600000",
        `node ${sq(remoteDriver)}`,
        'echo "driver-exit=$?"',
        `echo "--- final ---"; cat /tmp/.symphony/driver-final.json || true`,
      ].join("\n"),
      900,
    ),
  );

  // Capture bundles inside sandbox.
  // - work.bundle is the production-shaped delta bundle (spec: symphony-base..HEAD).
  // - work-full.bundle is a self-contained --all bundle so the smoke can verify
  //   the bundle on a host that does not share the base.
  evidence.push(
    await run(
      "create work bundles",
      [
        "set -euxo pipefail",
        `cd ${sq(remoteRepo)}`,
        "git log --oneline symphony-base..HEAD || true",
        "git status --short",
        `git bundle create ${sq(remoteBundle)} symphony-base..HEAD`,
        `git bundle create ${sq(remoteFullBundle)} --all`,
        `ls -la ${sq(remoteBundle)} ${sq(remoteFullBundle)}`,
      ].join("\n"),
    ),
  );

  await sandbox.fs.downloadFiles([
    { source: remoteTranscript, destination: join(artifactDir, "transcript.jsonl") },
    { source: remoteOutcome, destination: join(artifactDir, "outcome.json") },
    { source: remoteBundle, destination: join(artifactDir, "work.bundle") },
    { source: remoteFullBundle, destination: join(artifactDir, "work-full.bundle") },
    { source: remoteStderr, destination: join(artifactDir, "codex.stderr.log") },
    {
      source: "/tmp/.symphony/driver-final.json",
      destination: join(artifactDir, "driver-final.json"),
    },
  ]);
} finally {
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

// Host-side validation
try {
  driverFinal = JSON.parse(readFileSync(join(artifactDir, "driver-final.json"), "utf8"));
} catch (err) {
  driverFinal = { readError: err instanceof Error ? err.message : String(err) };
}

const outcomePath = join(artifactDir, "outcome.json");
if (existsSync(outcomePath)) {
  const raw = readFileSync(outcomePath, "utf8");
  const decoded = await Effect.runPromise(
    Effect.either(Schema.decodeUnknown(WorkerOutcome)(JSON.parse(raw))),
  );
  if (decoded._tag === "Right") {
    outcome = decoded.right;
  } else {
    outcome = { decodeError: String(decoded.left), raw };
  }
}

// Host-side bundle verification.
// We attempt two fetches against an empty host repo:
//  (a) the spec-shaped delta bundle (symphony-base..HEAD) — expected to fail on a
//      bare host because the host doesn't share the base; the failure is recorded
//      to prove the production shape requires base-sharing;
//  (b) the --all bundle — must succeed and produce a usable symphony/<id> ref
//      with the worker's commits intact.
const hostRepoDir = join(root, "host-verify");
mkdirSync(hostRepoDir, { recursive: true });
sh("git init -q -b main", hostRepoDir);
sh('git config user.name "Smoke Verify"', hostRepoDir);
sh('git config user.email "smoke-verify@example.invalid"', hostRepoDir);
sh("git commit -q --allow-empty -m base", hostRepoDir);
const testId = `gx-${timestamp}`;
const bundleLogLines: string[] = [];

try {
  const out = sh(
    `git fetch ${sq(join(artifactDir, "work.bundle"))} '+HEAD:refs/symphony/${testId}-delta' 2>&1`,
    hostRepoDir,
  );
  bundleLogLines.push(`[delta-bundle] OK\n${out}`);
} catch (err) {
  bundleLogLines.push(
    `[delta-bundle] expected failure on bare host (no shared base): ${err instanceof Error ? err.message : String(err)}`,
  );
}

try {
  sh(
    `git fetch ${sq(join(artifactDir, "work-full.bundle"))} '+HEAD:refs/symphony/${testId}'`,
    hostRepoDir,
  );
  sh(`git branch symphony/${testId} refs/symphony/${testId}`, hostRepoDir);
  const log = sh(`git log --oneline refs/symphony/${testId} -n 5`, hostRepoDir);
  bundleLogLines.push(`[full-bundle] OK\n${log}`);
  hostBranch = `symphony/${testId}`;
  bundleVerified = true;
} catch (err) {
  bundleLogLines.push(`[full-bundle] FAILED: ${err instanceof Error ? err.message : String(err)}`);
}

writeFileSync(join(artifactDir, "host-bundle-log.txt"), `${bundleLogLines.join("\n\n")}\n`);

const manifest = {
  completedAt: new Date().toISOString(),
  apiUrl,
  target,
  snapshot: snapshotName,
  sandboxDeleted: deleted,
  driverFinal,
  outcome,
  bundleVerified,
  hostBranch,
  expectedMessage,
  evidence: evidence.map(({ name, command, exitCode }) => ({ name, command, exitCode })),
  artifactDir,
};
writeFileSync(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\nSmoke complete. Artifacts: ${artifactDir}`);
console.log(`outcome=${JSON.stringify(outcome)}`);
console.log(`bundleVerified=${bundleVerified} hostBranch=${hostBranch}`);
