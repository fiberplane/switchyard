import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Daytona } from "@daytona/sdk";
import type {} from "bun";

interface ProbeEvidence {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
}

const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
const artifactDir = join(process.cwd(), "artifacts", `auth-probe-${timestamp}`);
const remoteRoot = "/workspace/auth-probe";
const remoteAuth = "/tmp/codex-auth.json";
const remotePrompt = "/tmp/auth-probe-prompt.md";
const placeholderApiKey = "api-key-placeholder-for-precedence";

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

const sh = (command: string) =>
  execFileSync("bash", ["-lc", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const sq = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

const sanitize = (value: string) =>
  value
    .replaceAll(
      process.env.AUTH_PROBE_OPENAI_API_KEY ?? "__missing_auth_probe_api_key__",
      "[redacted-api-key]",
    )
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/sess-[A-Za-z0-9_-]+/g, "[redacted-session]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]");

const truncate = (value: string) => {
  const sanitized = sanitize(value);
  return sanitized.length > 12_000 ? `${sanitized.slice(0, 12_000)}\n[truncated]\n` : sanitized;
};

const runProbe = async (name: string, command: string, timeout = 180): Promise<ProbeEvidence> => {
  console.log(`\n== ${name} ==`);
  const result = await sandbox!.process.executeCommand(command, undefined, undefined, timeout);
  const output = truncate(result.result);
  console.log(`exit=${result.exitCode}`);
  if (output.trim().length > 0) {
    console.log(output);
  }
  return { name, command: sanitize(command), exitCode: result.exitCode, output };
};

const runRequired = async (name: string, command: string, timeout = 180) => {
  const evidence = await runProbe(name, command, timeout);
  if (evidence.exitCode !== 0) {
    throw new Error(`${name} failed with exit ${evidence.exitCode}`);
  }
  return evidence;
};

const home = (name: string) => `${remoteRoot}/${name}`;
const authShape = (path: string) => `node /tmp/auth-shape.js ${sq(path)}`;

const statusCommand = (homePath: string, extraEnv = "") =>
  ["set -uo pipefail", `${extraEnv} CODEX_HOME=${sq(homePath)} codex login status`].join("\n");

const execCommand = (
  homePath: string,
  label: string,
  options: {
    readonly extraEnv?: string;
    readonly ignoreUserConfig?: boolean;
  } = {},
) => {
  const lastMessage = `/tmp/auth-probe-${label}-last.txt`;
  const events = `/tmp/auth-probe-${label}-events.jsonl`;
  return [
    "set -uo pipefail",
    `rm -f ${sq(lastMessage)} ${sq(events)}`,
    [
      options.extraEnv,
      `CODEX_HOME=${sq(homePath)}`,
      "codex exec --json --skip-git-repo-check --ephemeral",
      options.ignoreUserConfig ? "--ignore-user-config" : "",
      "--dangerously-bypass-approvals-and-sandbox",
      "--cd /workspace",
      `--output-last-message ${sq(lastMessage)}`,
      `- < ${sq(remotePrompt)} > ${sq(events)}`,
    ]
      .filter(Boolean)
      .join(" "),
    "status=$?",
    `test -f ${sq(lastMessage)} && cat ${sq(lastMessage)} || true`,
    "exit $status",
  ].join("\n");
};

const repairLocalRunnerScheduling = () => {
  if (
    !apiUrl.startsWith("http://localhost:3000/") ||
    process.env.DAYTONA_SKIP_LOCAL_DB_REPAIR === "1"
  ) {
    return;
  }

  const sql = [
    "update runner",
    'set "availabilityScore"=100, "currentDiskUsagePercentage"=50',
    `where region=${sq(target)} and state='ready' and draining=false;`,
  ].join(" ");

  sh(`docker exec daytona-db-1 psql -U user -d daytona -v ON_ERROR_STOP=1 -c ${sq(sql)}`);
};

const apiKey = getRequired("DAYTONA_API_KEY", process.env.DAYTONA_API_KEY_FILE);
const apiUrl = process.env.DAYTONA_API_URL || "http://localhost:3000/api";
const target = process.env.DAYTONA_TARGET || "us";
const snapshotName = process.env.DAYTONA_SNAPSHOT || "symphony-codex-bun";
const codexAuthPath = process.env.CODEX_AUTH_JSON || `${process.env.HOME}/.codex/auth.json`;
const realApiKeyAvailable = Boolean(process.env.AUTH_PROBE_OPENAI_API_KEY);

if (!existsSync(codexAuthPath)) {
  throw new Error(`Codex auth file not found: ${codexAuthPath}`);
}

mkdirSync(artifactDir, { recursive: true });
chmodSync(artifactDir, 0o700);
writeFileSync(
  join(artifactDir, "prompt.md"),
  "Reply with exactly AUTH_PROBE_OK and no other text.\n",
);

console.log(`artifactDir=${artifactDir}`);
console.log(`apiUrl=${apiUrl}`);
console.log(`target=${target}`);
console.log(`snapshot=${snapshotName}`);
console.log(`realApiKeyAvailable=${realApiKeyAvailable}`);

const daytona = new Daytona({ apiKey, apiUrl, target });
let sandbox: Awaited<ReturnType<Daytona["create"]>> | undefined;
let deleted = false;
const evidence: ProbeEvidence[] = [];

try {
  const snapshot = await daytona.snapshot.get(snapshotName);
  if (snapshot.state !== "active") {
    throw new Error(`Snapshot ${snapshotName} is ${snapshot.state}, not active`);
  }

  const createSandbox = () =>
    daytona.create(
      {
        name: `auth-probe-${Date.now()}`,
        snapshot: snapshotName,
        language: "typescript",
        autoStopInterval: 15,
        autoDeleteInterval: -1,
        envVars: {
          SYMPHONY_ISSUE_ID: "qqou",
          SYMPHONY_ISSUE_DISPLAY_ID: "SWYRD-qqoumggw",
          ...(process.env.AUTH_PROBE_OPENAI_API_KEY
            ? { AUTH_PROBE_OPENAI_API_KEY: process.env.AUTH_PROBE_OPENAI_API_KEY }
            : {}),
        },
        labels: {
          app: "symphony",
          issue: "qqou",
          role: "codex-auth-probe",
        },
      },
      { timeout: 300 },
    );

  repairLocalRunnerScheduling();
  try {
    sandbox = await createSandbox();
  } catch (error) {
    if (error instanceof Error && error.message.includes("No available runners")) {
      repairLocalRunnerScheduling();
      sandbox = await createSandbox();
    } else {
      throw error;
    }
  }

  console.log(`sandbox id=${sandbox.id} name=${sandbox.name} state=${sandbox.state}`);

  await sandbox.fs.uploadFiles([
    { source: codexAuthPath, destination: remoteAuth },
    { source: join(artifactDir, "prompt.md"), destination: remotePrompt },
  ]);

  evidence.push(
    await runRequired(
      "setup auth homes",
      [
        "set -euxo pipefail",
        `rm -rf ${sq(remoteRoot)}`,
        `mkdir -p ${sq(home("chatgpt"))} ${sq(home("mixed"))} ${sq(home("api"))}`,
        `cp ${sq(remoteAuth)} ${sq(`${home("chatgpt")}/auth.json`)}`,
        `chmod 700 ${sq(home("chatgpt"))}`,
        `chmod 600 ${sq(`${home("chatgpt")}/auth.json`)}`,
        `cp ${sq(`${home("chatgpt")}/auth.json`)} ${sq(`${home("mixed")}/auth.json`)}`,
        `chmod 700 ${sq(home("mixed"))} ${sq(home("api"))}`,
        `chmod 600 ${sq(`${home("mixed")}/auth.json`)}`,
        "cat > /tmp/auth-shape.js <<'NODE'",
        "const { readFileSync } = require('node:fs');",
        "const path = process.argv[2];",
        "const payload = JSON.parse(readFileSync(path, 'utf8'));",
        "const hasOwn = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty);",
        "console.log(JSON.stringify({",
        "  path,",
        "  auth_mode: payload.auth_mode ?? null,",
        "  keys: Object.keys(payload).sort(),",
        "  has_tokens: hasOwn(payload, 'tokens'),",
        "  has_openai_api_key: hasOwn(payload, 'OPENAI_API_KEY'),",
        "}, null, 2));",
        "NODE",
      ].join("\n"),
    ),
  );

  evidence.push(
    await runProbe("chatgpt auth shape before exec", authShape(`${home("chatgpt")}/auth.json`)),
  );
  evidence.push(
    await runProbe(
      "chatgpt status with api env unset",
      statusCommand(home("chatgpt"), "env -u OPENAI_API_KEY -u SANDBOX_OPENAI_API_KEY"),
    ),
  );
  evidence.push(
    await runProbe(
      "chatgpt exec with ignore-user-config",
      execCommand(home("chatgpt"), "chatgpt-ignore-config", {
        extraEnv: "env -u OPENAI_API_KEY -u SANDBOX_OPENAI_API_KEY",
        ignoreUserConfig: true,
      }),
      900,
    ),
  );
  evidence.push(
    await runProbe(
      "chatgpt exec with user config allowed",
      execCommand(home("chatgpt"), "chatgpt-user-config", {
        extraEnv: "env -u OPENAI_API_KEY -u SANDBOX_OPENAI_API_KEY",
      }),
      900,
    ),
  );
  evidence.push(
    await runProbe("chatgpt auth shape after exec", authShape(`${home("chatgpt")}/auth.json`)),
  );

  evidence.push(
    await runProbe(
      "chatgpt status with placeholder OPENAI_API_KEY",
      statusCommand(home("chatgpt"), `OPENAI_API_KEY=${sq(placeholderApiKey)}`),
    ),
  );
  evidence.push(
    await runProbe(
      "chatgpt exec with placeholder OPENAI_API_KEY",
      execCommand(home("chatgpt"), "chatgpt-placeholder-env", {
        extraEnv: `OPENAI_API_KEY=${sq(placeholderApiKey)}`,
        ignoreUserConfig: true,
      }),
      900,
    ),
  );

  evidence.push(
    await runProbe(
      "mixed home login with placeholder api key",
      [
        "set -uo pipefail",
        `printf '%s\\n' ${sq(placeholderApiKey)} | CODEX_HOME=${sq(home("mixed"))} codex login --with-api-key`,
      ].join("\n"),
    ),
  );
  evidence.push(
    await runProbe(
      "mixed auth shape after placeholder login",
      authShape(`${home("mixed")}/auth.json`),
    ),
  );
  evidence.push(
    await runProbe("mixed status after placeholder login", statusCommand(home("mixed"))),
  );

  if (realApiKeyAvailable) {
    evidence.push(
      await runProbe(
        "api home login with real api key",
        [
          "set -uo pipefail",
          `printenv AUTH_PROBE_OPENAI_API_KEY | CODEX_HOME=${sq(home("api"))} codex login --with-api-key`,
        ].join("\n"),
      ),
    );
    evidence.push(
      await runProbe("api auth shape after real login", authShape(`${home("api")}/auth.json`)),
    );
    evidence.push(await runProbe("api status after real login", statusCommand(home("api"))));
    evidence.push(
      await runProbe(
        "api exec after real login",
        execCommand(home("api"), "api-real-login", { ignoreUserConfig: true }),
        900,
      ),
    );
  } else {
    evidence.push({
      name: "api key comparison skipped",
      command: "AUTH_PROBE_OPENAI_API_KEY was not set",
      exitCode: 0,
      output: "Skipped real API-key login and exec comparison.",
    });
  }
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

const failed = evidence.filter((probe) => probe.exitCode !== 0);
const result = {
  status: failed.length === 0 ? "completed" : "completed-with-probe-failures",
  completedAt: new Date().toISOString(),
  apiUrl,
  target,
  snapshot: snapshotName,
  sandboxDeleted: deleted,
  realApiKeyAvailable,
  failedProbeNames: failed.map((probe) => probe.name),
  probes: evidence,
};

writeFileSync(join(artifactDir, "auth-probe-result.json"), JSON.stringify(result, null, 2) + "\n");

console.log(`\nAuth probe complete. Artifacts: ${artifactDir}`);
if (failed.length > 0) {
  console.log(`Probe failures: ${failed.map((probe) => probe.name).join(", ")}`);
}
