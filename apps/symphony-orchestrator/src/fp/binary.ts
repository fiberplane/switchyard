import { delimiter, join, resolve as resolvePath } from "node:path";

import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";

export type FpBinaryOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly home?: string;
  readonly path?: string;
  readonly systemCandidates?: readonly string[];
};

export type FpBinaryShape = {
  readonly resolve: () => Effect.Effect<string>;
};

export class FpBinary extends Context.Tag("FpBinary")<FpBinary, FpBinaryShape>() {}

const currentEnv = (options: FpBinaryOptions): Record<string, string | undefined> =>
  options.env ?? process.env;

const currentHome = (options: FpBinaryOptions): string =>
  options.home ?? currentEnv(options).HOME ?? "";

const currentPath = (options: FpBinaryOptions): string =>
  options.path ?? currentEnv(options).PATH ?? "";

const systemCandidates = (options: FpBinaryOptions): readonly string[] =>
  options.systemCandidates ?? ["/usr/local/bin/fp"];

const configuredEnvPath = (options: FpBinaryOptions): readonly string[] => {
  const envPath = currentEnv(options).SWITCHYARD_FP_BIN;
  return envPath === undefined || envPath === "" ? [] : [resolvePath(envPath)];
};

const homeCandidates = (options: FpBinaryOptions): readonly string[] => {
  const home = currentHome(options);
  return home === "" ? [] : [join(home, ".fiberplane", "bin", "fp")];
};

const pathCandidates = (options: FpBinaryOptions): readonly string[] =>
  currentPath(options)
    .split(delimiter)
    .filter((entry) => entry !== "")
    .map((entry) => join(entry, "fp"));

const candidatesFor = (options: FpBinaryOptions): readonly string[] => [
  ...configuredEnvPath(options),
  ...systemCandidates(options),
  ...homeCandidates(options),
  ...pathCandidates(options),
];

const resolveBinaryPath = (options: FpBinaryOptions): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    for (const candidate of candidatesFor(options)) {
      const exists = yield* fs.exists(candidate).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (exists) {
        return candidate;
      }
    }

    return "";
  });

export const FpBinaryLive = (options: FpBinaryOptions = {}) =>
  Layer.effect(
    FpBinary,
    Effect.map(resolveBinaryPath(options), (resolvedPath) => ({
      resolve: () => Effect.succeed(resolvedPath),
    })),
  );
