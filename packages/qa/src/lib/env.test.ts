import { fileURLToPath } from "node:url";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";

import {
  decodeHostRuntimeConfig,
  loadHostEnv,
  type EnvMap,
  type HostRuntimeConfig,
} from "../../../../apps/symphony-orchestrator/src/config/host-runtime.js";

export type RemoteE2EEnv = {
  readonly raw: EnvMap;
  readonly host: HostRuntimeConfig;
  readonly testRunId: string;
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly allowedBranchPrefix: string;
  readonly owner: string;
  readonly keep: boolean;
};

const appRoot = fileURLToPath(new URL("../../../../apps/symphony-orchestrator/", import.meta.url));

const required = [
  "DAYTONA_API_KEY",
  "DAYTONA_SNAPSHOT",
  "GITHUB_TOKEN",
  "FP_REMOTE",
  "FP_TOKEN",
  "FP_SERVER_URL",
  "FP_WORKSPACE",
  "FP_PROJECT_ID",
  "SWITCHYARD_CODEX_AUTH",
] as const;

const currentBranch = async (): Promise<string> => {
  const { runCommand } = await import("./command.test.js");
  const result = await runCommand("git", ["branch", "--show-current"], {
    cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
  });
  const branch = result.stdout.trim();
  return branch.length === 0 ? "main" : branch;
};

export const loadRemoteE2EEnv = async (): Promise<RemoteE2EEnv | undefined> => {
  const raw = await Effect.runPromise(
    loadHostEnv(appRoot).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  if (raw.SWITCHYARD_REMOTE_DAYTONA_E2E !== "1") {
    console.warn("[skipped] remote Daytona E2E skipped; set SWITCHYARD_REMOTE_DAYTONA_E2E=1.");
    return undefined;
  }

  const missing = required.filter((key) => raw[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`remote Daytona E2E enabled but missing ${missing.join(", ")}`);
  }
  if (raw.FP_REMOTE !== "rest-api") {
    throw new Error("remote Daytona E2E requires FP_REMOTE=rest-api");
  }

  const allowedBranchPrefix =
    raw.SWITCHYARD_REMOTE_DAYTONA_ALLOWED_BRANCH_PREFIX ?? "symphony/e2e/";
  if (!allowedBranchPrefix.startsWith("symphony/e2e/")) {
    throw new Error("remote Daytona E2E branch prefix must start with symphony/e2e/");
  }

  const host = await Effect.runPromise(decodeHostRuntimeConfig(raw));
  return {
    raw,
    host,
    testRunId: raw.SWITCHYARD_REMOTE_DAYTONA_TEST_RUN_ID ?? crypto.randomUUID(),
    repoUrl:
      raw.SWITCHYARD_REMOTE_DAYTONA_REPO_URL ?? "https://github.com/fiberplane/switchyard.git",
    baseBranch: raw.SWITCHYARD_REMOTE_DAYTONA_BASE_BRANCH ?? (await currentBranch()),
    allowedBranchPrefix,
    owner: raw.SWITCHYARD_REMOTE_DAYTONA_OWNER ?? "switchyard-e2e",
    keep: raw.SWITCHYARD_REMOTE_DAYTONA_KEEP === "1",
  };
};

export const publicEnvSummary = (env: RemoteE2EEnv): Record<string, string> => ({
  SWITCHYARD_REMOTE_DAYTONA_E2E: "1",
  DAYTONA_SNAPSHOT: env.host.daytona.snapshotName ?? "[workflow]",
  FP_REMOTE: env.host.fpRest.remote,
  FP_SERVER_URL: "[configured]",
  FP_WORKSPACE: "[configured]",
  FP_PROJECT_ID: "[configured]",
  FP_PROJECT_PREFIX: env.host.fpRest.projectPrefix === undefined ? "[unset]" : "[configured]",
  GITHUB_TOKEN: "[present]",
  FP_TOKEN: "[present]",
  SWITCHYARD_CODEX_AUTH: "[configured]",
});
