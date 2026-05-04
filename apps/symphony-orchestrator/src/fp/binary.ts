import { Context, Effect, Layer } from "effect";

export type FpBinaryOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly home?: string;
  readonly path?: string;
};

export type FpBinaryShape = {
  readonly resolve: () => Effect.Effect<string>;
};

export class FpBinary extends Context.Tag("FpBinary")<FpBinary, FpBinaryShape>() {}

const currentEnv = (options: FpBinaryOptions): Record<string, string | undefined> =>
  options.env ?? process.env;

const resolveEnvOverride = (options: FpBinaryOptions): string =>
  currentEnv(options).SWITCHYARD_FP_BIN ?? "";

export const FpBinaryLive = (options: FpBinaryOptions = {}) =>
  Layer.succeed(FpBinary, {
    resolve: () => Effect.succeed(resolveEnvOverride(options)),
  });
