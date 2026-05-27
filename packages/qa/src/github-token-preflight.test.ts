import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";

import {
  appEnvPath,
  loadHostEnv,
  parseDotEnv,
} from "../../../apps/symphony-orchestrator/src/config/host-runtime.js";

const execFileAsync = promisify(execFile);

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

const repoRoot = path.resolve(import.meta.dir, "../../..");
const appRoot = path.join(repoRoot, "apps/symphony-orchestrator");

const runCommand = async (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CommandResult> => {
  try {
    const result = await execFileAsync(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 1024 * 1024 * 20,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const maybe = error as {
      readonly code?: unknown;
      readonly stdout?: unknown;
      readonly stderr?: unknown;
    };
    return {
      code: typeof maybe.code === "number" ? maybe.code : 1,
      stdout: typeof maybe.stdout === "string" ? maybe.stdout : "",
      stderr: typeof maybe.stderr === "string" ? maybe.stderr : String(error),
    };
  }
};

const tokenType = (token: string | undefined): string => {
  if (token === undefined) {
    return "missing";
  }
  if (token.startsWith("github_pat_")) {
    return "fine-grained";
  }
  if (token.startsWith("ghp_")) {
    return "classic";
  }
  return "unknown";
};

const fingerprint = (token: string | undefined): string =>
  token === undefined ? "missing" : createHash("sha256").update(token).digest("hex").slice(0, 12);

const tokenSummary = (label: string, token: string | undefined): string =>
  `${label}: type=${tokenType(token)} length=${token?.length ?? 0} fingerprint=${fingerprint(token)}`;

const redact = (input: string, token: string): string =>
  input
    .replaceAll(token, "[redacted-token]")
    .replaceAll(/https:\/\/[^@\s]+@github\.com\//gu, "https://[redacted]@github.com/");

const requireToken = (source: string, token: string | undefined): string => {
  if (token === undefined || token.length === 0) {
    throw new Error(`GITHUB_TOKEN missing from ${source}`);
  }
  return token;
};

const githubEnv = (token: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GITHUB_TOKEN: token,
  GH_TOKEN: token,
});

const ensureAllowedPrefix = (prefix: string): string => {
  if (!prefix.startsWith("symphony/e2e/")) {
    throw new Error("refusing diagnostic branch prefix outside symphony/e2e/");
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
};

const currentHead = async (): Promise<string> => {
  const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (result.code !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const printCommandFailure = (label: string, result: CommandResult, token: string): void => {
  console.log(`${label}: FAIL code=${result.code}`);
  const combined = `${result.stdout}${result.stderr}`;
  if (combined.length > 0) {
    console.log(redact(combined, token).trimEnd());
  }
};

const probeGithubIdentity = async (repo: string, token: string): Promise<boolean> => {
  const user = await runCommand("gh", ["api", "user", "--jq", ".login"], {
    env: githubEnv(token),
  });
  if (user.code !== 0) {
    printCommandFailure("gh user", user, token);
    return false;
  }
  console.log(`gh user: ${user.stdout.trim()}`);

  const repoResult = await runCommand(
    "gh",
    ["api", `repos/${repo}`, "--jq", "{full_name:.full_name, permissions:.permissions}"],
    { env: githubEnv(token) },
  );
  if (repoResult.code !== 0) {
    printCommandFailure("gh repo", repoResult, token);
    return false;
  }
  console.log(`gh repo: ${repoResult.stdout.trim()}`);
  return true;
};

const probeRestCreateRef = async (
  repo: string,
  branch: string,
  sha: string,
  token: string,
): Promise<boolean> => {
  const create = await runCommand(
    "gh",
    [
      "api",
      `repos/${repo}/git/refs`,
      "-X",
      "POST",
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${sha}`,
    ],
    { env: githubEnv(token) },
  );
  if (create.code !== 0) {
    printCommandFailure("REST create-ref", create, token);
    return false;
  }

  const remove = await runCommand(
    "gh",
    ["api", `repos/${repo}/git/refs/heads/${branch}`, "-X", "DELETE"],
    { env: githubEnv(token) },
  );
  if (remove.code !== 0) {
    printCommandFailure("REST delete-ref", remove, token);
    return false;
  }
  console.log("REST create/delete ref: PASS");
  return true;
};

const writeAskpass = (home: string): string => {
  const askpass = path.join(home, "askpass.sh");
  writeFileSync(
    askpass,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf "x-access-token" ;;',
      '  *Password*) printf "%s" "$GITHUB_TOKEN" ;;',
      '  *) printf "" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(askpass, 0o700);
  return askpass;
};

const isolatedGitEnv = (home: string, askpass: string, token: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ASKPASS: askpass,
  GITHUB_TOKEN: token,
  GIT_TERMINAL_PROMPT: "0",
});

const probeGitPush = async (repo: string, branch: string, token: string): Promise<boolean> => {
  const home = mkdtempSync(path.join(tmpdir(), "switchyard-github-token-"));
  const askpass = writeAskpass(home);
  const env = isolatedGitEnv(home, askpass, token);
  try {
    const create = await runCommand(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "credential.https://github.com.helper=",
        "push",
        "--porcelain",
        `https://github.com/${repo}.git`,
        `HEAD:refs/heads/${branch}`,
      ],
      { cwd: repoRoot, env },
    );
    if (create.code !== 0) {
      printCommandFailure("git push create", create, token);
      return false;
    }

    const remove = await runCommand(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "credential.https://github.com.helper=",
        "push",
        "--porcelain",
        `https://github.com/${repo}.git`,
        `:refs/heads/${branch}`,
      ],
      { cwd: repoRoot, env },
    );
    if (remove.code !== 0) {
      printCommandFailure("git push delete", remove, token);
      return false;
    }
    console.log("isolated git push/delete: PASS");
    return true;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const dotEnv = parseDotEnv(readFileSync(appEnvPath(appRoot), "utf8"));
  const effective = await Effect.runPromise(
    loadHostEnv(appRoot).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  const source = process.env.SWITCHYARD_GITHUB_PREFLIGHT_TOKEN_SOURCE ?? "effective";
  const token =
    source === "dotenv"
      ? requireToken("apps/symphony-orchestrator/.env", dotEnv.GITHUB_TOKEN)
      : requireToken("effective host env", effective.GITHUB_TOKEN);
  const repo = process.env.SWITCHYARD_GITHUB_PREFLIGHT_REPO ?? "fiberplane/switchyard";
  const prefix = ensureAllowedPrefix(
    process.env.SWITCHYARD_GITHUB_PREFLIGHT_PREFIX ?? "symphony/e2e/",
  );
  const branch = `${prefix}token-preflight-${randomUUID()}`;
  const sha = process.env.SWITCHYARD_GITHUB_PREFLIGHT_SHA ?? (await currentHead());

  console.log(`repo: ${repo}`);
  console.log(`sha: ${sha}`);
  console.log(`branch: ${branch}`);
  console.log(tokenSummary(".env GITHUB_TOKEN", dotEnv.GITHUB_TOKEN));
  console.log(tokenSummary("process.env GITHUB_TOKEN", process.env.GITHUB_TOKEN));
  console.log(tokenSummary("effective GITHUB_TOKEN", effective.GITHUB_TOKEN));
  console.log(`token source: ${source}`);
  if (
    dotEnv.GITHUB_TOKEN !== undefined &&
    process.env.GITHUB_TOKEN !== undefined &&
    dotEnv.GITHUB_TOKEN !== process.env.GITHUB_TOKEN
  ) {
    console.log("warning: process.env GITHUB_TOKEN overrides .env for the orchestrator loader");
  }

  const identityOk = await probeGithubIdentity(repo, token);
  const restOk = identityOk && (await probeRestCreateRef(repo, branch, sha, token));
  const pushOk = await probeGitPush(repo, branch, token);
  if (identityOk && restOk && pushOk) {
    console.log("github token preflight: PASS");
    return;
  }
  console.log("github token preflight: FAIL");
  process.exitCode = 1;
};

await main();
