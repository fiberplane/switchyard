import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Either } from "effect";

import { HostConfigError } from "../../src/config/errors.js";
import {
  decodeHostRuntimeConfig,
  loadHostEnv,
  parseDotEnv,
} from "../../src/config/host-runtime.js";

describe("host runtime config", () => {
  test("parses dotenv content and treats empty values as missing", () => {
    expect(
      parseDotEnv(`
        # comment
        export DAYTONA_API_KEY=from-file
        EMPTY=
        QUOTED="quoted-value"
      `),
    ).toEqual({
      DAYTONA_API_KEY: "from-file",
      EMPTY: undefined,
      QUOTED: "quoted-value",
    });
  });

  test("loads app dotenv then lets process env win", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "swy-host-env-"));
    try {
      writeFileSync(join(appRoot, ".env"), "DAYTONA_API_KEY=from-file\nFP_REMOTE=rest-api\n");
      const env = await Effect.runPromise(
        loadHostEnv(appRoot, {
          DAYTONA_API_KEY: "from-process",
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      );

      expect(env.DAYTONA_API_KEY).toBe("from-process");
      expect(env.FP_REMOTE).toBe("rest-api");
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  test("decodes typed remote host config without optional Daytona overrides", async () => {
    const config = await Effect.runPromise(
      decodeHostRuntimeConfig({
        DAYTONA_API_KEY: "daytona-secret",
        DAYTONA_API_URL: "",
        DAYTONA_TARGET: "",
        DAYTONA_SNAPSHOT: "",
        GITHUB_TOKEN: "github-secret",
        FP_REMOTE: "rest-api",
        FP_TOKEN: "fp-secret",
        FP_SERVER_URL: "https://app.fp.dev",
        FP_WORKSPACE: "fiberplane",
        FP_PROJECT_ID: "project",
        SWITCHYARD_CODEX_AUTH: "/tmp/auth.json",
      }),
    );

    expect(config).toEqual({
      daytona: {
        apiKey: "daytona-secret",
        apiUrl: undefined,
        target: undefined,
        snapshotName: undefined,
      },
      github: {
        token: "github-secret",
      },
      fpRest: {
        remote: "rest-api",
        token: "fp-secret",
        serverUrl: "https://app.fp.dev",
        workspace: "fiberplane",
        projectId: "project",
        projectPrefix: undefined,
      },
      codex: {
        authPath: "/tmp/auth.json",
      },
    });
  });

  test("reports missing or empty Daytona API key without printing secret values", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        decodeHostRuntimeConfig({
          DAYTONA_API_KEY: "",
          GITHUB_TOKEN: "github-secret",
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(HostConfigError);
      expect(result.left.message).toContain("DAYTONA_API_KEY");
      expect(result.left.message).not.toContain("github-secret");
    }
  });

  test("rejects non-REST fp mode without printing sibling secret values", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        decodeHostRuntimeConfig({
          DAYTONA_API_KEY: "daytona-secret",
          GITHUB_TOKEN: "github-secret",
          FP_REMOTE: "socket",
          FP_TOKEN: "fp-secret",
          SWITCHYARD_CODEX_AUTH: "/tmp/auth.json",
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(HostConfigError);
      expect(result.left.message).toContain("FP_REMOTE");
      expect(result.left.message).toContain("rest-api");
      expect(result.left.message).not.toContain("daytona-secret");
      expect(result.left.message).not.toContain("github-secret");
      expect(result.left.message).not.toContain("fp-secret");
    }
  });
});
