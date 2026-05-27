import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Either, Layer } from "effect";

import type { FpIssueDetail } from "../../src/fp/models.js";
import { WorkerPromptWriteError } from "../../src/prompt/errors.js";
import {
  MISSING_DESCRIPTION_FALLBACK,
  WORKER_PROMPT_HOST_FILENAME,
  WORKER_PROMPT_HOST_PREFIX,
  WORKER_PROMPT_SANDBOX_PATH,
} from "../../src/prompt/models.js";
import { WorkerPromptService, WorkerPromptServiceLive } from "../../src/prompt/service.js";

const fixturePath = (name: string) => `test/prompt/fixtures/${name}`;

const readIssueFixture = async (name: string): Promise<FpIssueDetail> =>
  JSON.parse(await Bun.file(fixturePath(name)).text()) as FpIssueDetail;

const layer = Layer.provide(WorkerPromptServiceLive, NodeFileSystem.layer);

const runRender = <A, E>(
  effect: Effect.Effect<A, E, WorkerPromptService | FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)));

const githubCloneSource = {
  kind: "githubClone" as const,
  repoUrl: "https://github.com/fiberplane/switchyard.git",
  baseBranch: "main",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  repoPath: "/workspace/repo",
  branchName: "symphony/SWYRD-abc123",
  metadataPath: "/tmp/.symphony/source.json",
  runId: "swy-swyrd-abc123-1",
  sandboxId: "sb-123",
  fpRestWorkdir: "/tmp/.symphony/fp-rest",
};

// Track every host tempdir created during a test so cleanup is reliable even on failure.
const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

const trackHostDir = (hostPath: string) => {
  createdDirs.push(dirname(hostPath));
};

describe("WorkerPromptService.renderPrompt — happy path", () => {
  test("returns content + hostPath + sandboxPath; file on disk equals content", async () => {
    const issue = await readIssueFixture("issue-with-description.json");

    const result = await runRender(
      Effect.gen(function* () {
        const service = yield* WorkerPromptService;
        return yield* service.renderPrompt({ issue, attempt: 1, source: githubCloneSource });
      }),
    );

    trackHostDir(result.hostPath);

    expect(result.sandboxPath).toBe(WORKER_PROMPT_SANDBOX_PATH);
    expect(result.hostPath.endsWith(`/${WORKER_PROMPT_HOST_FILENAME}`)).toBe(true);
    // The tempdir name reflects the prefix.
    expect(dirname(result.hostPath)).toContain(WORKER_PROMPT_HOST_PREFIX);
    // Tempdir is rooted under os.tmpdir().
    expect(result.hostPath.startsWith(tmpdir())).toBe(true);

    // Disk file contents match the in-memory content exactly (the dual return shape is
    // load-bearing — the runner consumer uses `content` for `turn/start.input`).
    const onDisk = await Bun.file(result.hostPath).text();
    expect(onDisk).toBe(result.content);

    // The rendered content carries the substituted issue identity.
    expect(result.content).toContain("SWYRD-abc123");
    expect(result.content).toContain("Add foo helper to message module");
    expect(result.content).toContain("Implement the foo helper.");
    expect(result.content).toContain("symphony/SWYRD-abc123");
  });

  test("renders githubClone source metadata and branch instructions", async () => {
    const issue = await readIssueFixture("issue-with-description.json");
    const result = await runRender(
      Effect.gen(function* () {
        const service = yield* WorkerPromptService;
        return yield* service.renderPrompt({
          issue,
          attempt: 1,
          source: githubCloneSource,
        });
      }),
    );

    trackHostDir(result.hostPath);
    expect(result.content).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(result.content).toContain("symphony/SWYRD-abc123");
    expect(result.content).toContain("/tmp/.symphony/source.json");
    expect(result.content).toContain("swy-swyrd-abc123-1");
    expect(result.content).toContain("sb-123");
    expect(result.content).toContain("FP_REMOTE=rest-api");
    expect(result.content).toContain("gh pr create");
    expect(result.content).toContain("symphony_pr_url");
    expect(result.content).toContain("babysit");
    expect(result.content).not.toContain("PrArtifactNotImplemented");
    expect(result.content).not.toContain("outcome.json");
    expect(result.content).not.toContain("symphony-base");
    expect(result.content).not.toContain("git bundle");
    expect(result.content).not.toContain("no `fp` credentials");
  });

  test("substitutes the fallback prose when description is null", async () => {
    const issue = await readIssueFixture("issue-no-description.json");

    const result = await runRender(
      Effect.gen(function* () {
        const service = yield* WorkerPromptService;
        return yield* service.renderPrompt({ issue, attempt: 1, source: githubCloneSource });
      }),
    );

    trackHostDir(result.hostPath);

    expect(result.content).toContain(MISSING_DESCRIPTION_FALLBACK);
    // The literal "null" line must not leak into the prompt where the description goes.
    expect(result.content).not.toMatch(/^null$/m);
  });

  test("substitutes the fallback prose when description is undefined (key absent)", async () => {
    const issue = await readIssueFixture("issue-with-description.json");
    // Build a variant without the description property at all (mirrors how
    // `Schema.optional` decodes a missing JSON key).
    const { description: _description, ...rest } = issue;
    void _description;
    const issueNoKey = rest as FpIssueDetail;

    const result = await runRender(
      Effect.gen(function* () {
        const service = yield* WorkerPromptService;
        return yield* service.renderPrompt({
          issue: issueNoKey,
          attempt: 1,
          source: githubCloneSource,
        });
      }),
    );

    trackHostDir(result.hostPath);
    expect(result.content).toContain(MISSING_DESCRIPTION_FALLBACK);
  });

  test("substitutes the fallback prose when description is whitespace-only", async () => {
    const issue = await readIssueFixture("issue-with-description.json");
    const blankIssue = { ...issue, description: "   \t \n  " };

    const result = await runRender(
      Effect.gen(function* () {
        const service = yield* WorkerPromptService;
        return yield* service.renderPrompt({
          issue: blankIssue,
          attempt: 2,
          source: githubCloneSource,
        });
      }),
    );

    trackHostDir(result.hostPath);
    expect(result.content).toContain(MISSING_DESCRIPTION_FALLBACK);
  });
});

describe("WorkerPromptService.renderPrompt — write failures", () => {
  // Pre-create a directory at the path `makeTempDirectory` would try to use (well — we
  // can't easily force that from the outside). Instead we use a different angle: write
  // into a non-existent absolute prefix that the FS will refuse to create. The sibling
  // pattern in `artifact/store.test.ts` exercises ENOENT this way.
  let blockedRoot: string;

  beforeEach(() => {
    // Create a tempdir, drop it to mode 0o500 (read+exec, no write) so makeTempDirectory
    // inside it fails with EACCES.
    blockedRoot = mkdtempSync(join(tmpdir(), "swy-prompt-blocked-"));
  });

  afterEach(() => {
    try {
      // Restore writable mode so cleanup works.
      Bun.spawnSync(["chmod", "-R", "u+w", blockedRoot]);
      rmSync(blockedRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("write failure surfaces as WorkerPromptWriteError carrying a permission-shaped reason", async () => {
    // Override TMPDIR for this test's process so makeTempDirectory targets the blocked
    // root. Restore after. Drop the dir to mode 0500 (read+exec, no write) so EACCES /
    // EPERM bubbles up from the underlying syscall.
    const issue = await readIssueFixture("issue-with-description.json");
    const originalTmp = process.env.TMPDIR;
    process.env.TMPDIR = blockedRoot;
    Bun.spawnSync(["chmod", "0500", blockedRoot]);

    try {
      const result = await runRender(
        Effect.either(
          Effect.gen(function* () {
            const service = yield* WorkerPromptService;
            return yield* service.renderPrompt({ issue, attempt: 1, source: githubCloneSource });
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isRight(result)) {
        return;
      }
      const error = result.left;
      expect(error).toBeInstanceOf(WorkerPromptWriteError);
      if (!(error instanceof WorkerPromptWriteError)) {
        return;
      }

      // The error must carry an informative path (real path or descriptive prefix glob)
      // and a reason that mentions the permission or filesystem failure mode — not just a
      // generic "operation failed" string. Stronger than length>0 because length>0 would
      // pass even if the FS layer mapped to an empty-but-defined error.
      expect(error.path.length).toBeGreaterThan(0);
      expect(error.reason.toLowerCase()).toMatch(/permission|denied|eacces|eperm|read-only/);
    } finally {
      // Restore TMPDIR before afterEach cleanup so subsequent tests / cleanup work.
      if (originalTmp === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmp;
      }
      Bun.spawnSync(["chmod", "u+w", blockedRoot]);
    }
  });
});
