import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Either } from "effect";

import { FpBinaryNotFoundError } from "../../src/fp/errors.js";
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

  test("falls back through system candidates, HOME, and PATH when env is unset", async () => {
    const root = await makeTempDir("swy-fp-fallback-");
    const systemDirectory = join(root, "usr-local-bin");
    const home = join(root, "home");
    const homeDirectory = join(home, ".fiberplane", "bin");
    const pathDirectory = join(root, "path-bin");

    await Promise.all([
      mkdir(systemDirectory, { recursive: true }),
      mkdir(homeDirectory, { recursive: true }),
      mkdir(pathDirectory, { recursive: true }),
    ]);

    const systemBinary = await makeExecutable(systemDirectory);
    const homeBinary = await makeExecutable(homeDirectory);
    const pathBinary = await makeExecutable(pathDirectory);

    const env = { SWITCHYARD_FP_BIN: undefined };

    await expect(
      runWithBinary(
        {
          env,
          home,
          path: pathDirectory,
          systemCandidates: [systemBinary],
        },
        resolveBinary,
      ),
    ).resolves.toBe(systemBinary);

    await expect(
      runWithBinary(
        {
          env,
          home,
          path: pathDirectory,
          systemCandidates: [join(root, "missing-system-fp")],
        },
        resolveBinary,
      ),
    ).resolves.toBe(homeBinary);

    await rm(homeBinary);
    await expect(
      runWithBinary(
        {
          env,
          home,
          path: pathDirectory,
          systemCandidates: [join(root, "missing-system-fp")],
        },
        resolveBinary,
      ),
    ).resolves.toBe(pathBinary);
  });

  test("fails with attempted paths when no fp binary is found", async () => {
    const root = await makeTempDir("swy-fp-missing-");
    const home = join(root, "home");
    const pathDirectory = join(root, "path-bin");
    const missingSystem = join(root, "missing-system-fp");
    const expectedHome = join(home, ".fiberplane", "bin", "fp");
    const expectedPath = join(pathDirectory, "fp");

    const result = await runWithBinary(
      {
        env: { SWITCHYARD_FP_BIN: undefined },
        home,
        path: pathDirectory,
        systemCandidates: [missingSystem],
      },
      Effect.either(resolveBinary),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(FpBinaryNotFoundError);
      if (result.left instanceof FpBinaryNotFoundError) {
        expect(result.left.attemptedPaths).toEqual([missingSystem, expectedHome, expectedPath]);
      }
    }
  });
});
