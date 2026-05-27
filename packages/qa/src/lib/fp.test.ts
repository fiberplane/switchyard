import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type { EligibleIssue } from "../../../../apps/symphony-orchestrator/src/fp/eligibility.js";
import {
  decodeFpIssueDetailJson,
  type FpIssueDetail,
} from "../../../../apps/symphony-orchestrator/src/fp/models.js";
import { decodeSymphonyProperties } from "../../../../apps/symphony-orchestrator/src/fp/symphony-properties.js";
import { runCommand } from "./command.test.js";
import type { RemoteE2EEnv } from "./env.test.js";

export type ScratchIssue = {
  readonly detail: FpIssueDetail;
  readonly workdir: string;
};

const fpEnv = (env: RemoteE2EEnv): NodeJS.ProcessEnv => ({
  ...process.env,
  FP_REMOTE: "rest-api",
  FP_TOKEN: env.host.fpRest.token,
  FP_SERVER_URL: env.host.fpRest.serverUrl,
  FP_WORKSPACE: env.host.fpRest.workspace,
  FP_PROJECT_ID: env.host.fpRest.projectId,
  FP_PROJECT_PREFIX: env.host.fpRest.projectPrefix,
});

const decodeIssue = async (content: string, path: string): Promise<FpIssueDetail> =>
  Effect.runPromise(decodeFpIssueDetailJson(content, path));

export const createScratchIssue = async (
  env: RemoteE2EEnv,
  description: string,
): Promise<ScratchIssue> => {
  const workdir = await mkdtemp(join(tmpdir(), "switchyard-remote-e2e-fp-"));
  const bodyPath = join(workdir, "issue.md");
  await writeFile(bodyPath, description);
  const result = await runCommand(
    "fp",
    [
      "issue",
      "create",
      "--title",
      `remote daytona e2e ${env.testRunId}`,
      "--description",
      bodyPath,
      "--property",
      "symphony_ready=true",
      "--format",
      "json",
    ],
    { cwd: workdir, env: fpEnv(env) },
  );
  return { detail: await decodeIssue(result.stdout, "fp issue create"), workdir };
};

export const showIssue = async (env: RemoteE2EEnv, id: string): Promise<FpIssueDetail> => {
  const workdir = await mkdtemp(join(tmpdir(), "switchyard-remote-e2e-fp-show-"));
  try {
    const result = await runCommand("fp", ["issue", "show", id, "--format", "json"], {
      cwd: workdir,
      env: fpEnv(env),
    });
    return await decodeIssue(result.stdout, `fp issue show ${id}`);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
};

export const cleanupScratchIssue = async (env: RemoteE2EEnv, id: string): Promise<void> => {
  const workdir = await mkdtemp(join(tmpdir(), "switchyard-remote-e2e-fp-cleanup-"));
  try {
    await runCommand(
      "fp",
      [
        "issue",
        "update",
        id,
        "--status",
        "done",
        "--property",
        "symphony_ready=false",
        "--property",
        "symphony_state=needs-attention",
        "--comment",
        `remote Daytona E2E ${env.testRunId} cleaned up after an incomplete run`,
      ],
      { cwd: workdir, env: fpEnv(env) },
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
};

export const toEligibleIssue = (detail: FpIssueDetail): EligibleIssue => {
  const decoded = decodeSymphonyProperties(detail.properties);
  if (decoded._tag === "Left") {
    throw new Error(`scratch issue properties failed to decode: ${decoded.left}`);
  }
  return { detail, properties: decoded.right };
};
