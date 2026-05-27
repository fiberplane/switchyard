import { describe, expect, test } from "bun:test";

import { makeRedactor, redactorFromConfig } from "../../src/secrets/redactor.js";

describe("redactor", () => {
  test("redacts and scans exact registered secret values", () => {
    const redactor = makeRedactor(["daytona-secret", "", "fp-secret"]);

    expect(redactor.redact("x daytona-secret y fp-secret")).toBe("x [redacted] y [redacted]");
    expect(redactor.scan("contains fp-secret")).toEqual({ found: true, count: 1 });
    expect(redactor.scan("clean")).toEqual({ found: false, count: 0 });
    expect(redactor.rejectIfPresent("contains daytona-secret")).toBe(
      "text contains 1 registered secret value(s)",
    );
  });

  test("builds from nested config without exposing secret values", () => {
    const redactor = redactorFromConfig({
      daytona: { apiKey: "daytona-secret", snapshotName: "snapshot-name" },
      github: { token: "github-secret" },
      fpRest: {
        remote: "rest-api",
        token: "fp-secret",
        serverUrl: "https://app.fp.dev",
        workspace: "fiberplane",
        projectId: "project-id",
      },
      codex: { authPath: "/tmp/codex/auth.json", authToken: "codex-secret" },
    });

    expect(
      redactor.redact(
        [
          "daytona-secret",
          "github-secret",
          "fp-secret",
          "codex-secret",
          "rest-api",
          "https://app.fp.dev",
          "/tmp/codex/auth.json",
        ].join(" "),
      ),
    ).toBe(
      [
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "rest-api",
        "https://app.fp.dev",
        "/tmp/codex/auth.json",
      ].join(" "),
    );
  });
});
