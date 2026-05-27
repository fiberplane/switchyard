import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { Chunk, Effect, Stream } from "effect";

import { loadHostEnv, type EnvMap } from "../../src/config/host-runtime.js";
import { createDaytonaClient } from "../../src/daytona/daytona-client.js";
import { DaytonaAdapter, DaytonaAdapterLive } from "../../src/daytona/daytona.adapter.js";
import { DaytonaSession, DaytonaSessionLive } from "../../src/daytona/daytona.session.js";
import type { DaytonaConfig, SandboxHandle } from "../../src/daytona/models.js";
import { decodeDaytonaConfigEnv } from "../../src/daytona/models.js";
import { makeRedactor } from "../../src/secrets/redactor.js";
import {
  buildRemoteTestSandboxSpec,
  cleanupRemoteTestSandboxes,
  listRemoteTestSandboxes,
  remoteKeepSandbox,
  remoteOwnerLabel,
  reportKeptRemoteSandboxes,
} from "./test-helpers/remote-cloud.js";

type RemoteContext = {
  readonly config: DaytonaConfig;
  readonly env: EnvMap;
  readonly testRunId: string;
};

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const remoteFlag = "SWITCHYARD_REMOTE_DAYTONA_TEST";
const fpSmokeFlag = "SWITCHYARD_REMOTE_DAYTONA_FP_SMOKE";
const fpSmokeIssue = "SWITCHYARD_REMOTE_DAYTONA_FP_ISSUE";

let remoteContext: RemoteContext | undefined;
let remoteSkipReason: string | undefined;

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

const loadRemoteContext = async (): Promise<RemoteContext | undefined> => {
  const env = await Effect.runPromise(
    loadHostEnv(appRoot).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  if (env[remoteFlag] !== "1") {
    remoteSkipReason = `remote Daytona Cloud smoke skipped; set ${remoteFlag}=1 to enable.`;
    return undefined;
  }

  const missing = ["DAYTONA_API_KEY", "DAYTONA_SNAPSHOT"].filter((key) => env[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`remote Daytona Cloud smoke enabled but missing ${missing.join(", ")}`);
  }

  const config = await Effect.runPromise(decodeDaytonaConfigEnv(env));
  remoteSkipReason = undefined;
  return {
    config,
    env,
    testRunId: crypto.randomUUID(),
  };
};

const runRemoteTest = (
  name: string,
  body: (context: RemoteContext) => Promise<void>,
  timeoutMs = 300_000,
) =>
  test(
    name,
    async () => {
      if (remoteContext === undefined) {
        console.warn(`[skipped] ${remoteSkipReason}`);
        return;
      }

      await body(remoteContext);
    },
    timeoutMs,
  );

const runWithAdapter = <A, E>(
  config: DaytonaConfig,
  effect: Effect.Effect<A, E, DaytonaAdapter>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(DaytonaAdapterLive(config)), Effect.provide(NodeContext.layer)),
  );

const runWithSession = <A, E>(
  config: DaytonaConfig,
  effect: Effect.Effect<A, E, DaytonaSession>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(DaytonaSessionLive(config)), Effect.provide(NodeContext.layer)),
  );

const withRemoteSandbox = async <A>(
  context: RemoteContext,
  purpose: string,
  body: (handle: SandboxHandle) => Promise<A>,
): Promise<A> => {
  const handle = await runWithAdapter(
    context.config,
    Effect.gen(function* () {
      const adapter = yield* DaytonaAdapter;
      return yield* adapter.createSandbox(
        buildRemoteTestSandboxSpec({
          testRunId: context.testRunId,
          snapshotName: context.config.snapshotName,
          owner: remoteOwnerLabel(context.env),
          labels: { purpose },
          envVars: {},
        }),
      );
    }),
  );

  try {
    return await body(handle);
  } finally {
    if (remoteKeepSandbox(context.env)) {
      await reportKeptRemoteSandboxes(context.config, context.testRunId);
    } else {
      await runWithAdapter(
        context.config,
        Effect.gen(function* () {
          const adapter = yield* DaytonaAdapter;
          yield* adapter.deleteSandbox(handle);
        }),
      );
    }
  }
};

const assertNoSecretText = (
  context: RemoteContext,
  content: string,
  extraSecrets: readonly string[] = [],
): void => {
  const redactor = makeRedactor([context.config.apiKey, ...extraSecrets]);
  expect(redactor.scan(content)).toEqual({ found: false, count: 0 });
};

const definedEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

const toolVerifierCommand = `
set -euo pipefail
for tool in git gh fp rg bash curl jq bun codex drift; do
  command -v "$tool" >/dev/null || { echo "missing:$tool"; exit 10; }
done
if command -v sg >/dev/null; then
  sg --version
elif command -v ast-grep >/dev/null; then
  ast-grep --version
else
  echo "missing:ast-grep"
  exit 10
fi
git --version
gh --version | head -1
fp --version
rg --version | head -1
bash --version | head -1
curl --version | head -1
jq --version
bun --version
codex --version
drift --version
`;

const daytonaSecretSurfaceCommand = `
set -euo pipefail
if env | grep -q '^DAYTONA_API_KEY='; then
  echo "leak:daytona-api-key-env"
  exit 20
fi
if find /tmp /home/daytona /workspace -maxdepth 5 -name '*DAYTONA_API_KEY*' -print -quit 2>/dev/null | grep -q .; then
  echo "leak:daytona-api-key-file-name"
  exit 21
fi
if find /tmp /home/daytona /workspace -maxdepth 5 -type f -print0 2>/dev/null | xargs -0 grep -Il 'DAYTONA_API_KEY' 2>/dev/null | head -1 | grep -q .; then
  echo "leak:daytona-api-key-file-content"
  exit 22
fi
echo no-daytona-api-key-surface
`;

describe("remote Daytona Cloud smoke", () => {
  beforeAll(async () => {
    remoteContext = await loadRemoteContext();
  });

  test("remote smoke stays decoupled from local Daytona compose helpers", async () => {
    const testImports = (await readFile(fileURLToPath(import.meta.url), "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("import "))
      .join("\n");
    const helperSource = await readFile(
      fileURLToPath(new URL("./test-helpers/remote-cloud.ts", import.meta.url)),
      "utf8",
    );
    const source = [testImports, helperSource].join("\n");
    expect(source).not.toContain("sandbox-spec");
    expect(source).not.toContain("stack.js");
    expect(source).not.toContain(["ensure", "StackUp"].join(""));
    expect(source).not.toContain("compose");
  });

  test("remote sandbox spec uses canonical Cloud test labels", () => {
    const testRunId = crypto.randomUUID();
    const spec = buildRemoteTestSandboxSpec({
      testRunId,
      snapshotName: "snapshot-for-static-test",
      owner: "review-test-owner",
      labels: {
        app: "wrong-app",
        source: "wrong-source",
        test_run_id: "wrong-run",
        created_at_ms: "0",
        owner: "wrong-owner",
        purpose: "label-contract",
      },
    });

    expect(spec.labels.app).toBe("symphony-test");
    expect(spec.labels.source).toBe("remote-daytona");
    expect(spec.labels.test_run_id).toBe(testRunId);
    expect(spec.labels.created_at_ms).not.toBe("0");
    expect(spec.labels.owner).toBe("review-test-owner");
    expect(spec.labels.purpose).toBe("label-contract");
  });

  test("remote cleanup refuses an empty test_run_id", async () => {
    const config = remoteContext?.config ?? {
      apiKey: "dummy-api-key",
      snapshotName: "dummy-snapshot",
    };
    await expect(cleanupRemoteTestSandboxes(config, "")).rejects.toHaveProperty(
      "_tag",
      "RemoteDaytonaCleanupError",
    );
  });

  test("loads gated remote context", () => {
    if (remoteContext === undefined) {
      console.warn(`[skipped] ${remoteSkipReason}`);
      return;
    }

    expect(remoteContext.config.apiKey.length).toBeGreaterThan(0);
    expect(remoteContext.config.snapshotName.length).toBeGreaterThan(0);
  });

  runRemoteTest(
    "lists snapshots and verifies the configured snapshot is active",
    async (context) => {
      const client = createDaytonaClient(context.config);
      const list = await client.snapshot.list(1, 25);
      expect(Array.isArray(list.items)).toBe(true);

      await runWithAdapter(
        context.config,
        Effect.gen(function* () {
          const adapter = yield* DaytonaAdapter;
          yield* adapter.assertSnapshot(context.config.snapshotName);
        }),
      );
    },
  );

  runRemoteTest(
    "creates, verifies tools, transfers a file, and checks secret surfaces",
    async (context) => {
      await withRemoteSandbox(context, "cloud-lifecycle", async (handle) => {
        const transferRoot = await mkdtemp(join(tmpdir(), "swy-remote-daytona-"));
        const sourcePath = join(transferRoot, "tiny.txt");
        const copyPath = join(transferRoot, "tiny-copy.txt");
        await writeFile(sourcePath, "switchyard remote cloud smoke\n");

        try {
          const outputs = await runWithAdapter(
            context.config,
            Effect.gen(function* () {
              const adapter = yield* DaytonaAdapter;
              const toolCheck = yield* adapter.executeCommand(handle, toolVerifierCommand, {
                timeoutSec: 120,
              });
              yield* adapter.uploadFiles(handle, [{ src: sourcePath, dst: "/tmp/swy-tiny.txt" }]);
              const transferCheck = yield* adapter.executeCommand(
                handle,
                "test -s /tmp/swy-tiny.txt && cat /tmp/swy-tiny.txt",
              );
              yield* adapter.downloadFiles(handle, [{ src: "/tmp/swy-tiny.txt", dst: copyPath }]);
              const secretCheck = yield* adapter.executeCommand(
                handle,
                daytonaSecretSurfaceCommand,
                {
                  timeoutSec: 120,
                },
              );
              return { toolCheck, transferCheck, secretCheck };
            }),
          );

          if (outputs.toolCheck.exitCode !== 0) {
            throw new Error(
              `tool verifier failed: stdout=${outputs.toolCheck.stdout} stderr=${outputs.toolCheck.stderr}`,
            );
          }
          expect(outputs.transferCheck.exitCode).toBe(0);
          expect(outputs.transferCheck.stdout).toBe("switchyard remote cloud smoke\n");
          expect(outputs.secretCheck.exitCode).toBe(0);
          expect(outputs.secretCheck.stdout).toContain("no-daytona-api-key-surface");
          expect(sha256(await readFile(copyPath))).toBe(sha256(await readFile(sourcePath)));
          assertNoSecretText(context, JSON.stringify(outputs));
        } finally {
          await rm(transferRoot, { recursive: true, force: true });
        }
      });
    },
  );

  runRemoteTest("streams through DaytonaSession with the existing exit trap", async (context) => {
    await withRemoteSandbox(context, "cloud-session", async (handle) => {
      const result = await runWithSession(
        context.config,
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* DaytonaSession;
            const stream = yield* session.start(handle, "printf 'cloud-session-ok\\n'; sleep 5");
            const collected = yield* Stream.runCollect(stream.receive).pipe(
              Effect.timeoutFail({
                duration: "15 seconds",
                onTimeout: () => new Error("remote DaytonaSession receive timed out"),
              }),
            );
            const exit = yield* stream.waitExit;
            return {
              stdout: Chunk.toReadonlyArray(collected).join(""),
              exit,
            };
          }),
        ),
      );

      expect(result.exit.exitCode).toBe(0);
      expect(result.stdout).toContain("cloud-session-ok");
      assertNoSecretText(context, JSON.stringify(result));
    });
  });

  runRemoteTest(
    "optionally reads fp issue state from the sandbox in REST mode",
    async (context) => {
      if (context.env[fpSmokeFlag] !== "1") {
        console.warn(`[skipped] optional fp read smoke skipped; set ${fpSmokeFlag}=1 to enable.`);
        return;
      }

      const required = ["FP_TOKEN", "FP_SERVER_URL", "FP_WORKSPACE", "FP_PROJECT_ID", fpSmokeIssue];
      const missing = required.filter((key) => context.env[key] === undefined);
      if (missing.length > 0) {
        throw new Error(`optional fp read smoke enabled but missing ${missing.join(", ")}`);
      }

      await withRemoteSandbox(context, "cloud-fp-read", async (handle) => {
        const output = await runWithAdapter(
          context.config,
          Effect.gen(function* () {
            const adapter = yield* DaytonaAdapter;
            return yield* adapter.executeCommand(
              handle,
              [
                'fp issue show "$SWITCHYARD_REMOTE_DAYTONA_FP_ISSUE" --format json >/tmp/swy-fp-read.json',
                "jq -e '(.id // .displayId) != null' /tmp/swy-fp-read.json >/dev/null",
                "echo fp-read-ok",
              ].join("\n"),
              {
                env: definedEnv({
                  FP_REMOTE: "rest-api",
                  FP_TOKEN: context.env.FP_TOKEN,
                  FP_SERVER_URL: context.env.FP_SERVER_URL,
                  FP_WORKSPACE: context.env.FP_WORKSPACE,
                  FP_PROJECT_ID: context.env.FP_PROJECT_ID,
                  FP_PROJECT_PREFIX: context.env.FP_PROJECT_PREFIX,
                  SWITCHYARD_REMOTE_DAYTONA_FP_ISSUE: context.env[fpSmokeIssue],
                }),
                timeoutSec: 120,
              },
            );
          }),
        );

        assertNoSecretText(context, JSON.stringify(output), [context.env.FP_TOKEN ?? ""]);
        if (output.exitCode !== 0) {
          throw new Error(`fp read smoke failed: stdout=${output.stdout} stderr=${output.stderr}`);
        }
        expect(output.stdout).toContain("fp-read-ok");
      });
    },
  );

  runRemoteTest(
    "cleans remote test sandboxes by canonical test_run_id labels",
    async (context) => {
      if (remoteKeepSandbox(context.env)) {
        await reportKeptRemoteSandboxes(context.config, context.testRunId);
        return;
      }

      await runWithAdapter(
        context.config,
        Effect.gen(function* () {
          const adapter = yield* DaytonaAdapter;
          return yield* adapter.createSandbox(
            buildRemoteTestSandboxSpec({
              testRunId: context.testRunId,
              snapshotName: context.config.snapshotName,
              owner: remoteOwnerLabel(context.env),
              labels: { purpose: "cleanup-by-label" },
              envVars: {},
            }),
          );
        }),
      );

      expect(await listRemoteTestSandboxes(context.config, context.testRunId)).not.toHaveLength(0);
      await cleanupRemoteTestSandboxes(context.config, context.testRunId);
      expect(await listRemoteTestSandboxes(context.config, context.testRunId)).toHaveLength(0);
    },
    180_000,
  );
});
