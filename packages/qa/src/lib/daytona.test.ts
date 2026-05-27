import { Buffer } from "node:buffer";

import type { Sandbox } from "@daytona/sdk";
import { Either, Schema } from "effect";

import { createDaytonaClient } from "../../../../apps/symphony-orchestrator/src/daytona/daytona-client.js";
import type { DaytonaConfig } from "../../../../apps/symphony-orchestrator/src/daytona/models.js";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const CommandEnvelopeSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdoutBase64: Schema.String,
  stderrBase64: Schema.String,
});

export const listE2ESandboxes = async (
  config: DaytonaConfig,
  testRunId: string,
): Promise<Sandbox[]> => {
  if (testRunId.length === 0) {
    throw new Error("remote Daytona E2E cleanup refused: missing test_run_id");
  }
  const client = createDaytonaClient(config);
  const result = await client.list(
    { app: "symphony-test", source: "remote-daytona", test_run_id: testRunId },
    1,
    100,
  );
  return result.items;
};

export const cleanupE2ESandboxes = async (
  config: DaytonaConfig,
  testRunId: string,
): Promise<void> => {
  const sandboxes = await listE2ESandboxes(config, testRunId);
  for (const sandbox of sandboxes) {
    await sandbox.delete(120);
  }
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const remaining = await listE2ESandboxes(config, testRunId);
    if (remaining.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const remaining = await listE2ESandboxes(config, testRunId);
  if (remaining.length > 0) {
    throw new Error(`sandbox cleanup left ${remaining.length} matching sandbox(es)`);
  }
};

export const inspectSandboxGitConfig = async (
  config: DaytonaConfig,
  sandboxId: string,
  expectedRepoUrl: string,
): Promise<string> => {
  const client = createDaytonaClient(config);
  const sandbox = await client.get(sandboxId);
  const command = [
    "set -euo pipefail",
    "origin=$(git -C /workspace/repo remote get-url origin)",
    'if [ "$origin" != "$EXPECTED_REPO_URL" ]; then',
    '  echo "unexpected origin remote" >&2',
    "  exit 42",
    "fi",
    "git -C /workspace/repo remote -v",
    "git -C /workspace/repo config --show-origin --get-regexp 'remote\\..*\\.url|credential' || true",
  ].join("\n");
  const response = await sandbox.process.executeCommand(
    [
      "stdout_file=$(mktemp)",
      "stderr_file=$(mktemp)",
      `bash -lc ${shellQuote(command)} >"$stdout_file" 2>"$stderr_file"`,
      "status=$?",
      'printf \'{"exitCode":%s,"stdoutBase64":"\' "$status"',
      'base64 -w 0 "$stdout_file"',
      'printf \'","stderrBase64":"\'',
      'base64 -w 0 "$stderr_file"',
      "printf '\"}\\n'",
      'rm -f "$stdout_file" "$stderr_file"',
      "exit 0",
    ].join("\n"),
    undefined,
    { EXPECTED_REPO_URL: expectedRepoUrl },
    120,
  );
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(CommandEnvelopeSchema))(
    response.result,
  );
  if (Either.isLeft(decoded)) {
    throw new Error("sandbox git inspection response did not match expected schema");
  }
  const envelope = decoded.right;
  const stdout = Buffer.from(envelope.stdoutBase64, "base64").toString("utf8");
  const stderr = Buffer.from(envelope.stderrBase64, "base64").toString("utf8");
  if (envelope.exitCode !== 0) {
    throw new Error(`sandbox git inspection failed: ${stdout}${stderr}`);
  }
  return `${stdout}${stderr}`;
};

export const inspectSandboxSecretCleanup = async (
  config: DaytonaConfig,
  sandboxId: string,
): Promise<string> => {
  const client = createDaytonaClient(config);
  const sandbox = await client.get(sandboxId);
  const command = [
    "set -euo pipefail",
    "test ! -e /tmp/.symphony/worker-env",
    "test ! -e /tmp/.symphony/codex-home/auth.json",
    "printf 'secret cleanup paths absent\\n'",
  ].join("\n");
  const response = await sandbox.process.executeCommand(
    [
      "stdout_file=$(mktemp)",
      "stderr_file=$(mktemp)",
      `bash -lc ${shellQuote(command)} >"$stdout_file" 2>"$stderr_file"`,
      "status=$?",
      'printf \'{"exitCode":%s,"stdoutBase64":"\' "$status"',
      'base64 -w 0 "$stdout_file"',
      'printf \'","stderrBase64":"\'',
      'base64 -w 0 "$stderr_file"',
      "printf '\"}\\n'",
      'rm -f "$stdout_file" "$stderr_file"',
      "exit 0",
    ].join("\n"),
    undefined,
    {},
    120,
  );
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(CommandEnvelopeSchema))(
    response.result,
  );
  if (Either.isLeft(decoded)) {
    throw new Error("sandbox secret cleanup response did not match expected schema");
  }
  const envelope = decoded.right;
  const stdout = Buffer.from(envelope.stdoutBase64, "base64").toString("utf8");
  const stderr = Buffer.from(envelope.stderrBase64, "base64").toString("utf8");
  if (envelope.exitCode !== 0) {
    throw new Error(`sandbox secret cleanup inspection failed: ${stdout}${stderr}`);
  }
  return `${stdout}${stderr}`;
};
