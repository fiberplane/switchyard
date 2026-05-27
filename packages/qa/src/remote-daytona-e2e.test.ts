import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunContext } from "@effect/platform-bun";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { ArtifactStoreLive } from "../../../apps/symphony-orchestrator/src/artifact/store.js";
import { DaytonaAdapterLive } from "../../../apps/symphony-orchestrator/src/daytona/daytona.adapter.js";
import { DaytonaSessionLive } from "../../../apps/symphony-orchestrator/src/daytona/daytona.session.js";
import type { DaytonaConfig } from "../../../apps/symphony-orchestrator/src/daytona/models.js";
import { FpAdapterLive } from "../../../apps/symphony-orchestrator/src/fp/adapter.js";
import { FpBinaryLive } from "../../../apps/symphony-orchestrator/src/fp/binary.js";
import { FpServiceLive } from "../../../apps/symphony-orchestrator/src/fp/service.js";
import {
  toDaytonaConfig,
  toOrchestratorConfig,
} from "../../../apps/symphony-orchestrator/src/index.js";
import { GitAdapterLive } from "../../../apps/symphony-orchestrator/src/integration/git.adapter.js";
import { IntegrationServiceLive } from "../../../apps/symphony-orchestrator/src/integration/service.js";
import {
  OrchestratorService,
  OrchestratorServiceLive,
} from "../../../apps/symphony-orchestrator/src/orchestrator/service.js";
import { WorkerPromptServiceLive } from "../../../apps/symphony-orchestrator/src/prompt/service.js";
import { AgentRunnerLive } from "../../../apps/symphony-orchestrator/src/runner/service.js";
import { SandboxScriptServiceLive } from "../../../apps/symphony-orchestrator/src/sandbox-scripts/service.js";
import { loadWorkflowConfig } from "../../../apps/symphony-orchestrator/src/workflow/loader.js";
import { WorkflowServiceLive } from "../../../apps/symphony-orchestrator/src/workflow/service.js";
import {
  cleanupE2ESandboxes,
  inspectSandboxGitConfig,
  listE2ESandboxes,
} from "./lib/daytona.test.js";
import { loadRemoteE2EEnv, publicEnvSummary } from "./lib/env.test.js";
import {
  cleanupScratchIssue,
  createScratchIssue,
  showIssue,
  toEligibleIssue,
} from "./lib/fp.test.js";
import {
  assertGithubWriteAccess,
  assertRemoteBaseBranch,
  cleanupPrAndBranch,
  viewPr,
} from "./lib/github.test.js";
import { makeSecretScanner } from "./lib/secret-scan.test.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const qaRoot = fileURLToPath(new URL("..", import.meta.url));
const artifactRoot = join(repoRoot, ".symphony/remote-e2e-runs");

const readFixture = async (name: string): Promise<string> =>
  readFile(join(qaRoot, "fixtures", name), "utf8");

const scanFileIfPresent = async (
  scanner: ReturnType<typeof makeSecretScanner>,
  label: string,
  path: string,
): Promise<void> => {
  scanner.scan(label, await readFile(path, "utf8"));
};

const collectAuthSecrets = async (path: string | undefined): Promise<readonly string[]> => {
  if (path === undefined) {
    return [];
  }
  const auth = JSON.parse(await readFile(path, "utf8")) as unknown;
  const output = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length >= 16) {
        output.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        collect(entry);
      }
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) {
        collect(entry);
      }
    }
  };
  collect(auth);
  return Array.from(output);
};

const writeWorkflow = async (
  dir: string,
  input: {
    readonly snapshot: string;
    readonly repoUrl: string;
    readonly baseBranch: string;
    readonly branchPrefix: string;
  },
): Promise<string> => {
  const template = await readFixture("workflow-remote-daytona.yaml");
  const content = template
    .replace("<DAYTONA_SNAPSHOT>", input.snapshot)
    .replace("https://github.com/fiberplane/switchyard.git", input.repoUrl)
    .replace("<BASE_BRANCH>", input.baseBranch)
    .replace("<BRANCH_PREFIX>", input.branchPrefix);
  const path = join(dir, "WORKFLOW.remote-daytona.yml");
  await writeFile(path, content);
  return path;
};

const expectedRunIdFor = (displayId: string): string =>
  `swy-${displayId.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}-1`;

const buildLayer = (
  workflowPath: string,
  daytonaConfig: DaytonaConfig,
  rawEnv: Record<string, string | undefined>,
  testRunId: string,
  owner: string,
) =>
  Effect.gen(function* () {
    const workflow = yield* loadWorkflowConfig(workflowPath);
    const daytonaLayers = Layer.merge(
      DaytonaAdapterLive(daytonaConfig, { probeOnInit: true }),
      DaytonaSessionLive(daytonaConfig),
    );
    const fpStack = FpServiceLive.pipe(
      Layer.provide(FpAdapterLive({ cwd: repoRoot, env: rawEnv })),
      Layer.provide(FpBinaryLive()),
    );
    const integrationStack = IntegrationServiceLive.pipe(
      Layer.provide(GitAdapterLive({ cwd: repoRoot, env: rawEnv })),
    );
    const sandboxScripts = SandboxScriptServiceLive.pipe(Layer.provide(daytonaLayers));
    const orchestrator = OrchestratorServiceLive({
      ...toOrchestratorConfig(workflow, {
        github: { token: rawEnv.GITHUB_TOKEN },
        fpRest: {
          remote: "rest-api",
          token: rawEnv.FP_TOKEN,
          serverUrl: rawEnv.FP_SERVER_URL,
          workspace: rawEnv.FP_WORKSPACE,
          projectId: rawEnv.FP_PROJECT_ID,
          projectPrefix: rawEnv.FP_PROJECT_PREFIX,
        },
        codex: { authPath: rawEnv.SWITCHYARD_CODEX_AUTH },
      }),
      sandboxNameFor: (issue, attempt) =>
        `symphony-e2e-${testRunId.slice(0, 8)}-${issue.detail.displayId.toLowerCase()}-${attempt}`,
      sandboxLabelsFor: (_issue, _attempt, base) => ({
        ...base,
        app: "symphony-test",
        source: "remote-daytona",
        test_run_id: testRunId,
        owner,
      }),
    });

    return orchestrator.pipe(
      Layer.provide(
        Layer.mergeAll(
          daytonaLayers,
          sandboxScripts,
          WorkerPromptServiceLive,
          AgentRunnerLive,
          ArtifactStoreLive(artifactRoot),
          integrationStack,
          fpStack,
          WorkflowServiceLive,
          BunContext.layer,
        ),
      ),
    );
  });

export const runE2E = async (): Promise<void> => {
  const env = await loadRemoteE2EEnv();
  if (env === undefined) {
    return;
  }

  const scanner = makeSecretScanner([
    env.host.daytona.apiKey,
    env.host.github.token,
    env.host.fpRest.token,
    ...(await collectAuthSecrets(env.host.codex.authPath)),
  ]);
  console.log(`remote Daytona E2E test_run_id=${env.testRunId}`);
  console.log(JSON.stringify(publicEnvSummary(env)));

  const pinnedBaseSha = await assertRemoteBaseBranch(env);
  await assertGithubWriteAccess(env, pinnedBaseSha);
  const workdir = await mkdtemp(join(tmpdir(), "switchyard-remote-daytona-e2e-"));
  const daytonaConfig = toDaytonaConfig(
    {
      kind: "daytona",
      snapshot: env.host.daytona.snapshotName ?? "missing-snapshot",
      language: "typescript",
      autoStopInterval: 15,
      autoDeleteInterval: -1,
      repoPath: "/workspace/repo",
      sourceStrategy: "githubClone",
      artifactStrategy: "pr",
      repoUrl: env.repoUrl,
      baseBranch: env.baseBranch,
    },
    env.host,
  );
  let scratchWorkdir: string | undefined;
  let scratchIssueId: string | undefined;
  let scratchCompleted = false;
  let branch: string | undefined;
  let prNumber: string | undefined;
  let primaryError: unknown;
  const cleanupErrors: string[] = [];

  try {
    const taskTemplate = await readFixture("remote-daytona-code-task.md");
    const scratch = await createScratchIssue(
      env,
      taskTemplate.replaceAll("{{TEST_RUN_ID}}", env.testRunId),
    );
    scratchWorkdir = scratch.workdir;
    scratchIssueId = scratch.detail.id;
    console.log(`scratch_issue=${scratch.detail.displayId}`);

    const workflowPath = await writeWorkflow(workdir, {
      snapshot: daytonaConfig.snapshotName,
      repoUrl: env.repoUrl,
      baseBranch: env.baseBranch,
      branchPrefix: env.allowedBranchPrefix,
    });
    const layer = await Effect.runPromise(
      buildLayer(workflowPath, daytonaConfig, env.raw, env.testRunId, env.owner).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorService;
        return yield* orchestrator.runOne(toEligibleIssue(scratch.detail));
      }).pipe(Effect.provide(layer), Effect.provide(NodeContext.layer)),
    );
    scanner.scan("orchestrator result", JSON.stringify(result));
    branch = result.branch;
    if (result.status !== "integrated" || result.branch === undefined) {
      throw new Error(`remote E2E did not integrate: ${JSON.stringify(result)}`);
    }
    await scanFileIfPresent(
      scanner,
      "transcript",
      join(artifactRoot, "runs", scratch.detail.id, "1", "transcript.jsonl"),
    );
    await scanFileIfPresent(
      scanner,
      "outcome record",
      join(artifactRoot, "runs", scratch.detail.id, "1", "outcome-record.json"),
    );
    const finalBranch = result.branch;
    branch = finalBranch;
    if (!finalBranch.startsWith(env.allowedBranchPrefix)) {
      throw new Error(
        `worker branch ${finalBranch} does not start with ${env.allowedBranchPrefix}`,
      );
    }

    const finalIssue = await showIssue(env, scratch.detail.id);
    scanner.scan("fp final issue", JSON.stringify(finalIssue));
    const props = toEligibleIssue(finalIssue).properties;
    const finalPrNumber = props.symphony_pr_number;
    if (finalPrNumber === undefined || finalPrNumber.length === 0) {
      throw new Error("remote E2E missing symphony_pr_number");
    }
    prNumber = finalPrNumber;
    const pr = await viewPr(env, finalPrNumber);
    scanner.scan("github pr json", JSON.stringify(pr));
    const expectedRunId = expectedRunIdFor(finalIssue.displayId);
    const sandboxId = props.symphony_sandbox_id;
    if (sandboxId === undefined) {
      throw new Error("remote E2E missing symphony_sandbox_id");
    }
    const sandboxes = await listE2ESandboxes(daytonaConfig, env.testRunId);
    if (sandboxes.length !== 1) {
      throw new Error(`expected one labelled sandbox, found ${sandboxes.length}`);
    }
    const sandbox = sandboxes[0];
    if (sandbox === undefined) {
      throw new Error("expected one labelled sandbox, found none");
    }

    const expectations = [
      finalIssue.status === "done",
      props.symphony_state === "end",
      props.symphony_branch === finalBranch,
      props.symphony_pr_url === pr.url,
      props.symphony_pr_number === String(pr.number),
      props.symphony_head_sha === pr.headRefOid,
      props.symphony_base_sha === pinnedBaseSha,
      props.symphony_run_id === expectedRunId,
      sandboxId === sandbox.id,
      sandbox.labels.run_id === expectedRunId,
      sandbox.labels.test_run_id === env.testRunId,
      sandbox.labels.source === "remote-daytona",
      sandbox.labels.app === "symphony-test",
      pr.headRefName === finalBranch,
      pr.baseRefOid === pinnedBaseSha,
      pr.isDraft === false,
      pr.state === "OPEN",
    ];
    if (expectations.some((ok) => !ok)) {
      throw new Error("remote E2E metadata agreement check failed");
    }
    scanner.scan(
      "sandbox git remotes",
      await inspectSandboxGitConfig(daytonaConfig, sandboxId, env.repoUrl),
    );
    scratchCompleted = true;
    const evidence = [
      "# Result: Remote Daytona E2E",
      "",
      `**Status:** PASS`,
      `**Test Run:** ${env.testRunId}`,
      `**Scratch Issue:** ${finalIssue.displayId}`,
      `**Branch:** ${finalBranch}`,
      `**PR:** ${pr.url}`,
      `**Sandbox:** ${sandboxId}`,
      "",
      "## Verification",
      "",
      "- fp REST scratch issue reached `status=done` and `symphony_state=end`.",
      "- GitHub PR URL, number, branch, head SHA, and pinned base SHA matched fp metadata.",
      "- Sandbox git remote/config inspection contained no registered secret values.",
      "- Daytona sandbox labels matched `app=symphony-test`, `source=remote-daytona`, and the test run id.",
      "- Exact-value secret scan passed for inspected orchestrator result, transcript, fp JSON, and PR JSON.",
      "",
    ].join("\n");
    const evidencePath = join(qaRoot, "results", `remote-daytona-e2e-${env.testRunId}.md`);
    scanner.scan("evidence", evidence);
    await mkdir(join(qaRoot, "results"), { recursive: true });
    await writeFile(evidencePath, evidence);
    console.log(`evidence=${evidencePath}`);
  } catch (error) {
    primaryError = error;
  } finally {
    if (!env.keep) {
      if (scratchIssueId !== undefined) {
        await showIssue(env, scratchIssueId)
          .then((latestIssue) => {
            const props = toEligibleIssue(latestIssue).properties;
            branch ??= props.symphony_branch;
            prNumber ??= props.symphony_pr_number;
          })
          .catch((error) => {
            cleanupErrors.push(
              `fp cleanup metadata read: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      await cleanupPrAndBranch(env, prNumber, branch).catch((error) => {
        cleanupErrors.push(`PR cleanup: ${error instanceof Error ? error.message : String(error)}`);
      });
      await cleanupE2ESandboxes(daytonaConfig, env.testRunId).catch((error) => {
        cleanupErrors.push(
          `sandbox cleanup: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (scratchIssueId !== undefined && !scratchCompleted) {
        await cleanupScratchIssue(env, scratchIssueId).catch((error) => {
          cleanupErrors.push(
            `fp cleanup: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      if (cleanupErrors.length > 0) {
        console.warn(`remote Daytona E2E cleanup failed: ${cleanupErrors.join("; ")}`);
      }
    } else {
      console.warn(`keeping remote E2E artifacts for ${env.testRunId}`);
    }
    await rm(workdir, { recursive: true, force: true });
    if (scratchWorkdir !== undefined) {
      await rm(scratchWorkdir, { recursive: true, force: true });
    }
  }

  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, new Error(`cleanup failed: ${cleanupErrors.join("; ")}`)],
      "remote Daytona E2E failed",
    );
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error(`remote Daytona E2E cleanup failed: ${cleanupErrors.join("; ")}`);
  }
};
