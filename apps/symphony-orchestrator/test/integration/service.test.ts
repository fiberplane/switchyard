import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { GitAdapterLive } from "../../src/integration/git.adapter.js";
import { IntegrationService, IntegrationServiceLive } from "../../src/integration/service.js";
import { headSha, setupHostRepo, type HostRepo } from "./test-helpers/host-repo.js";

let host: HostRepo;

beforeEach(async () => {
  host = await setupHostRepo();
});

afterEach(async () => {
  await host?.cleanup();
});

const layer = () =>
  Layer.provide(
    IntegrationServiceLive,
    Layer.merge(GitAdapterLive({ cwd: host.dir, env: host.env }), NodeContext.layer),
  );

const runWithService = <A, E>(effect: Effect.Effect<A, E, IntegrationService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer()), Effect.provide(NodeContext.layer)));

describe("IntegrationService.prepareSourceHandoff", () => {
  test("returns baseRev matching HEAD and a tar.gz archive containing tracked files", async () => {
    const expected = await headSha(host.dir);

    const handoff = await runWithService(
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.prepareSourceHandoff();
      }),
    );

    expect(handoff.baseRev).toBe(expected);
    expect(handoff.archivePath.startsWith(tmpdir())).toBe(true);
    expect(await Bun.file(handoff.archivePath).exists()).toBe(true);

    const listing = (await Bun.$`tar -tzf ${handoff.archivePath}`.text()).split("\n");
    expect(listing).toContain("README.md");
    expect(listing).toContain("src.ts");

    expect(handoff.archivePath.endsWith(".tar.gz")).toBe(true);
    // archivePath is under os.tmpdir() — caller owns cleanup; remove to avoid leaking.
    await Bun.$`rm -f ${handoff.archivePath}`;
  });
});
