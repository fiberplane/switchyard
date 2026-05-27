import path from "node:path";

import { FileSystem } from "@effect/platform";
import { Effect, ParseResult, Schema } from "effect";

import { HostConfigError } from "./errors.js";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const OptionalNonEmptyString = Schema.optional(NonEmptyString);

const HostRuntimeEnvSchema = Schema.Struct({
  DAYTONA_API_KEY: NonEmptyString,
  DAYTONA_API_URL: OptionalNonEmptyString,
  DAYTONA_TARGET: OptionalNonEmptyString,
  DAYTONA_SNAPSHOT: OptionalNonEmptyString,
  GITHUB_TOKEN: OptionalNonEmptyString,
  FP_REMOTE: Schema.optionalWith(Schema.Literal("rest-api"), {
    default: () => "rest-api",
  }),
  FP_TOKEN: OptionalNonEmptyString,
  FP_SERVER_URL: OptionalNonEmptyString,
  FP_WORKSPACE: OptionalNonEmptyString,
  FP_PROJECT_ID: OptionalNonEmptyString,
  FP_PROJECT_PREFIX: OptionalNonEmptyString,
  SWITCHYARD_CODEX_AUTH: OptionalNonEmptyString,
});

export const HostRuntimeConfigSchema = Schema.Struct({
  daytona: Schema.Struct({
    apiKey: NonEmptyString,
    apiUrl: OptionalNonEmptyString,
    target: OptionalNonEmptyString,
    snapshotName: OptionalNonEmptyString,
  }),
  github: Schema.Struct({
    token: OptionalNonEmptyString,
  }),
  fpRest: Schema.Struct({
    remote: NonEmptyString,
    token: OptionalNonEmptyString,
    serverUrl: OptionalNonEmptyString,
    workspace: OptionalNonEmptyString,
    projectId: OptionalNonEmptyString,
    projectPrefix: OptionalNonEmptyString,
  }),
  codex: Schema.Struct({
    authPath: OptionalNonEmptyString,
  }),
});
export type HostRuntimeConfig = Schema.Schema.Type<typeof HostRuntimeConfigSchema>;

export type EnvMap = Record<string, string | undefined>;

export const appEnvPath = (appRoot: string): string => path.join(appRoot, ".env");

const stripOptionalQuotes = (value: string): string => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

export const parseDotEnv = (content: string): EnvMap => {
  const env: EnvMap = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = assignment.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }

    const value = stripOptionalQuotes(assignment.slice(separatorIndex + 1).trim());
    env[key] = value.length === 0 ? undefined : value;
  }

  return env;
};

export const loadAppDotEnv = (
  appRoot: string,
): Effect.Effect<EnvMap, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(appEnvPath(appRoot));
    return parseDotEnv(content);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logDebug("host dotenv not loaded", {
        error: String(error),
        path: appEnvPath(appRoot),
      }).pipe(Effect.as({})),
    ),
  );

export const mergeHostEnv = (dotEnv: EnvMap, processEnv: EnvMap): EnvMap => ({
  ...dotEnv,
  ...processEnv,
});

export const loadHostEnv = (
  appRoot: string,
  processEnv: EnvMap = process.env,
): Effect.Effect<EnvMap, never, FileSystem.FileSystem> =>
  loadAppDotEnv(appRoot).pipe(Effect.map((dotEnv) => mergeHostEnv(dotEnv, processEnv)));

const missingConfigEnvFields = (env: unknown): readonly string[] => {
  if (typeof env !== "object" || env === null) {
    return ["DAYTONA_API_KEY"];
  }

  const value = (env as Record<string, unknown>).DAYTONA_API_KEY;
  return typeof value === "string" && value.length > 0 ? [] : ["DAYTONA_API_KEY"];
};

const normalizeEnv = (env: unknown): unknown => {
  if (typeof env !== "object" || env === null) {
    return env;
  }

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === "" ? undefined : value]),
  );
};

export const decodeHostRuntimeConfig = (
  env: unknown,
): Effect.Effect<HostRuntimeConfig, HostConfigError> =>
  Schema.decodeUnknown(HostRuntimeEnvSchema)(normalizeEnv(env)).pipe(
    Effect.flatMap((decodedEnv) =>
      Schema.decodeUnknown(HostRuntimeConfigSchema)({
        daytona: {
          apiKey: decodedEnv.DAYTONA_API_KEY,
          apiUrl: decodedEnv.DAYTONA_API_URL,
          target: decodedEnv.DAYTONA_TARGET,
          snapshotName: decodedEnv.DAYTONA_SNAPSHOT,
        },
        github: {
          token: decodedEnv.GITHUB_TOKEN,
        },
        fpRest: {
          remote: decodedEnv.FP_REMOTE,
          token: decodedEnv.FP_TOKEN,
          serverUrl: decodedEnv.FP_SERVER_URL,
          workspace: decodedEnv.FP_WORKSPACE,
          projectId: decodedEnv.FP_PROJECT_ID,
          projectPrefix: decodedEnv.FP_PROJECT_PREFIX,
        },
        codex: {
          authPath: decodedEnv.SWITCHYARD_CODEX_AUTH,
        },
      }),
    ),
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new HostConfigError({
          missingFields: missingConfigEnvFields(env),
          details: ParseResult.TreeFormatter.formatErrorSync(error),
        }),
      ),
    ),
  );
