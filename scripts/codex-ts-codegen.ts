#!/usr/bin/env bun
import { rename, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_CODEX_VERSION = "0.128.0";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerDir = resolve(repoRoot, "apps/symphony-orchestrator/src/runner");
const outputDir = resolve(runnerDir, "protocol");
const stampPath = resolve(runnerDir, ".codegen-stamp.json");

type SemVer = readonly [number, number, number];

const parseSemVer = (version: string): SemVer | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
};

const compareSemVer = (a: SemVer, b: SemVer): number => {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
};

const die = (message: string): never => {
  process.stderr.write(`codex-ts-codegen: ${message}\n`);
  process.exit(1);
};

const checkCodexVersion = async (): Promise<string> => {
  const proc = Bun.spawn(["codex", "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return die(
      `\`codex --version\` failed (exit ${exitCode}). Install codex-cli >= ${REQUIRED_CODEX_VERSION}.\nstderr: ${stderr.trim()}`,
    );
  }

  // codex --version prints e.g. "codex-cli 0.128.0"
  const trimmed = stdout.trim();
  const tokens = trimmed.split(/\s+/);
  const versionToken = tokens[tokens.length - 1] ?? "";
  const observed = parseSemVer(versionToken);
  const required = parseSemVer(REQUIRED_CODEX_VERSION);

  if (observed === null || required === null) {
    return die(
      `Could not parse codex version from \`codex --version\` output: ${JSON.stringify(trimmed)}.\nExpected codex-cli >= ${REQUIRED_CODEX_VERSION}.`,
    );
  }

  if (compareSemVer(observed, required) < 0) {
    return die(
      `codex-cli ${versionToken} is older than required >= ${REQUIRED_CODEX_VERSION}.\nUpgrade with your codex-cli installer (e.g. \`bun add -g @openai/codex@latest\`) and re-run \`bun run codegen\`.`,
    );
  }

  return versionToken;
};

const runCodexGenerate = async (intoDir: string): Promise<void> => {
  const proc = Bun.spawn(["codex", "app-server", "generate-ts", "--out", intoDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    die(`\`codex app-server generate-ts\` failed with exit code ${exitCode}.`);
  }
};

const countGeneratedFiles = async (dir: string): Promise<number> => {
  const glob = new Bun.Glob("**/*.ts");
  let count = 0;
  for await (const _ of glob.scan({ cwd: dir })) {
    count++;
  }
  return count;
};

const writeStamp = async (codexVersion: string, fileCount: number): Promise<void> => {
  const stamp = {
    codexVersion,
    requiredCodexVersion: REQUIRED_CODEX_VERSION,
    generatedAt: new Date().toISOString(),
    fileCount,
  };
  await Bun.write(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
};

const main = async (): Promise<void> => {
  const relOut = relative(repoRoot, outputDir);
  process.stdout.write(`codex-ts-codegen: requiring codex-cli >= ${REQUIRED_CODEX_VERSION}\n`);
  const codexVersion = await checkCodexVersion();
  process.stdout.write(`codex-ts-codegen: codex ${codexVersion} OK\n`);

  // Generate into a sibling temp dir, then atomically swap. If codex fails
  // partway through, the existing protocol/ is left intact so the working tree
  // stays buildable.
  const tmpDir = `${outputDir}.tmp-${process.pid}`;
  await rm(tmpDir, { recursive: true, force: true });

  try {
    process.stdout.write(
      `codex-ts-codegen: generating bindings into ${relative(repoRoot, tmpDir)}\n`,
    );
    await runCodexGenerate(tmpDir);
    const fileCount = await countGeneratedFiles(tmpDir);

    await rm(outputDir, { recursive: true, force: true });
    await rename(tmpDir, outputDir);

    await writeStamp(codexVersion, fileCount);
    process.stdout.write(
      `codex-ts-codegen: wrote ${fileCount} .ts files to ${relOut} (stamp: ${relative(repoRoot, stampPath)})\n`,
    );
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
};

await main();
