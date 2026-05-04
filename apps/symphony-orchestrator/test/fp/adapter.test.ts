import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { FpIssueListSchema } from "../../src/fp/models.js";

const fixturePath = (name: string) => `test/fixtures/fp/${name}`;

describe("FpIssueListSchema", () => {
  test("decodes the recorded issue list fixture", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(FpIssueListSchema)(await Bun.file(fixturePath("issue-list.json")).json()),
    );

    expect(decoded.issues).toHaveLength(1);
    expect(decoded.issues[0]?.shortId).toBe("xyfynabp");
    expect(decoded.issues[0]?.status).toBe("in-progress");
  });
});
