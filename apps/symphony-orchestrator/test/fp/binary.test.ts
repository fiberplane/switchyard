import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";

import { FpBinary, FpBinaryLive, type FpBinaryOptions } from "../../src/fp/binary.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const makeExecutable = async (directory: string, name = "fp"): Promise<string> => {
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
};

const makeTempDir = async (prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
};

const resolveBinary = Effect.gen(function* () {
  const fpBinary = yield* FpBinary;
  return yield* fpBinary.resolve();
});

const runWithBinary = <A, E>(
  options: FpBinaryOptions,
  effect: Effect.Effect<A, E, FpBinary | FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(FpBinaryLive(options)), Effect.provide(NodeFileSystem.layer)));

describe("FpBinary.resolve", () => {
  test("returns the path from SWITCHYARD_FP_BIN when set", async () => {
    const directory = await makeTempDir("swy-fp-bin-");
    const binaryPath = await makeExecutable(directory);

    const resolved = await runWithBinary(
      { env: { SWITCHYARD_FP_BIN: binaryPath }, home: directory, path: "" },
      resolveBinary,
    );

    expect(resolved).toBe(binaryPath);
  });
});
