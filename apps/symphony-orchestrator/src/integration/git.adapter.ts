import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command, CommandExecutor, Error as PlatformError, FileSystem } from "@effect/platform";
import { Chunk, Context, Effect, Layer, Stream } from "effect";

import { makeRedactor } from "../secrets/redactor.js";
import { BundleFetchError, GitCommandError } from "./errors.js";

export type GitAdapterOptions = {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
};

export type GitAdapterShape = {
  readonly revParse: (rev: string) => Effect.Effect<string, GitCommandError>;
  readonly lsRemoteHead: (
    repoUrl: string,
    branch: string,
    token?: string,
  ) => Effect.Effect<string, GitCommandError>;
  readonly archive: (rev: string, outputPath: string) => Effect.Effect<void, GitCommandError>;
  readonly fetchBundle: (
    bundlePath: string,
    refspec: string,
  ) => Effect.Effect<void, GitCommandError | BundleFetchError>;
  readonly branchExists: (name: string) => Effect.Effect<boolean, GitCommandError>;
  readonly branchCreate: (name: string, ref: string) => Effect.Effect<void, GitCommandError>;
  readonly revListCount: (args: readonly string[]) => Effect.Effect<number, GitCommandError>;
};

export class GitAdapter extends Context.Tag("GitAdapter")<GitAdapter, GitAdapterShape>() {}

const currentCwd = (options: GitAdapterOptions): string => options.cwd ?? process.cwd();

const currentEnv = (options: GitAdapterOptions): Record<string, string | undefined> =>
  options.env ?? process.env;

const decodeOutput = (chunks: Chunk.Chunk<Uint8Array>): string => {
  const arrays = Chunk.toReadonlyArray(chunks);
  const length = arrays.reduce((total, bytes) => total + bytes.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const bytes of arrays) {
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return new TextDecoder().decode(output);
};

const collectOutput = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  Stream.runCollect(stream).pipe(Effect.map(decodeOutput));

const commandError = (command: readonly string[], stderr: string, exitCode = -1): GitCommandError =>
  new GitCommandError({
    command,
    stderr,
    exitCode,
  });

const redactGitCommandError = (token: string | undefined) => (error: GitCommandError) => {
  if (token === undefined) {
    return error;
  }
  const redactor = makeRedactor([token]);
  return new GitCommandError({
    command: error.command,
    stderr: redactor.redact(error.stderr),
    exitCode: error.exitCode,
  });
};

const askPassScript = `#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\\n' x-access-token ;;
  *Password*) printf '%s\\n' "$GITHUB_TOKEN" ;;
  *) printf '\\n' ;;
esac
`;

const tokenlessGitHubAuthEnv = {
  GH_TOKEN: "",
  GIT_ASKPASS: "",
  GITHUB_TOKEN: "",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_PARAMETERS: "",
  GIT_CONFIG_SYSTEM: "/dev/null",
  SSH_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
} as const;

export const runGitCommand = (
  args: readonly string[],
  options: GitAdapterOptions,
  executor: CommandExecutor.CommandExecutor,
  env: Record<string, string | undefined> = {},
): Effect.Effect<
  { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
  GitCommandError
> =>
  Effect.gen(function* () {
    const commandParts = ["git", ...args];
    const command = Command.make("git", ...args).pipe(
      Command.workingDirectory(currentCwd(options)),
      Command.env({ ...currentEnv(options), ...env }),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const process = yield* executor.start(command);
        const result = yield* Effect.all(
          {
            stdout: collectOutput(process.stdout),
            stderr: collectOutput(process.stderr),
            exitCode: process.exitCode,
          },
          { concurrency: "unbounded" },
        );
        return result;
      }),
    ).pipe(
      Effect.catchTags({
        BadArgument: (error) => Effect.fail(commandError(commandParts, error.message)),
        SystemError: (error) => Effect.fail(commandError(commandParts, error.message)),
      }),
    );
  });

const withGitHubAskPassEnv = <A, E>(
  fs: FileSystem.FileSystem,
  token: string | undefined,
  effect: (env: Record<string, string | undefined>, cwd: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | GitCommandError> => {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const dir = yield* fs
        .makeTempDirectory({ prefix: "swy-git-askpass-", directory: tmpdir() })
        .pipe(
          Effect.mapError((error: PlatformError.PlatformError) =>
            commandError(["git", "askpass"], error.message),
          ),
        );
      if (token === undefined) {
        return { dir, script: undefined };
      }

      const script = join(dir, "askpass.sh");
      yield* fs
        .writeFileString(script, askPassScript, { mode: 0o700 })
        .pipe(
          Effect.mapError((error: PlatformError.PlatformError) =>
            commandError(["git", "askpass"], error.message),
          ),
        );
      yield* fs
        .chmod(script, 0o700)
        .pipe(
          Effect.mapError((error: PlatformError.PlatformError) =>
            commandError(["git", "askpass"], error.message),
          ),
        );
      return { dir, script };
    }),
    ({ dir }) => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore),
  ).pipe(
    Effect.flatMap(({ dir, script }) => {
      if (token === undefined) {
        return effect(tokenlessGitHubAuthEnv, dir);
      }
      return effect(
        {
          ...tokenlessGitHubAuthEnv,
          GIT_ASKPASS: script,
          GITHUB_TOKEN: token,
        },
        dir,
      );
    }),
    Effect.scoped,
  );
};

const runGitSuccess = (
  args: readonly string[],
  options: GitAdapterOptions,
  executor: CommandExecutor.CommandExecutor,
  env: Record<string, string | undefined> = {},
): Effect.Effect<string, GitCommandError> =>
  Effect.gen(function* () {
    const result = yield* runGitCommand(args, options, executor, env);
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        commandError(["git", ...args], result.stderr.trim(), result.exitCode),
      );
    }
    return result.stdout;
  });

export const GitAdapterLive = (options: GitAdapterOptions = {}) =>
  Layer.effect(
    GitAdapter,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      const fs = yield* FileSystem.FileSystem;

      return {
        revParse: (rev) =>
          runGitSuccess(["rev-parse", rev], options, executor).pipe(
            Effect.map((stdout) => stdout.trim()),
          ),
        lsRemoteHead: (repoUrl, branch, token) =>
          withGitHubAskPassEnv(fs, token, (env, cwd) =>
            runGitSuccess(
              ["-c", "credential.helper=", "ls-remote", "--heads", repoUrl, branch],
              { ...options, cwd },
              executor,
              env,
            ).pipe(Effect.mapError(redactGitCommandError(token))),
          ),
        archive: (rev, outputPath) =>
          runGitSuccess(
            ["archive", "--format=tar.gz", "-o", outputPath, rev],
            options,
            executor,
          ).pipe(Effect.asVoid),
        fetchBundle: (bundlePath, refspec) =>
          Effect.gen(function* () {
            const result = yield* runGitCommand(
              ["fetch", "--no-tags", bundlePath, refspec],
              options,
              executor,
            );
            if (result.exitCode !== 0) {
              return yield* Effect.fail(
                new BundleFetchError({
                  bundlePath,
                  stderr: result.stderr.trim(),
                  exitCode: result.exitCode,
                }),
              );
            }
            return undefined;
          }),
        branchExists: (name) =>
          Effect.gen(function* () {
            const result = yield* runGitCommand(
              ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
              options,
              executor,
            );
            // git show-ref --verify exits 0 when ref exists, 1 when missing.
            // Any other exit code indicates a real failure.
            if (result.exitCode === 0) {
              return true;
            }
            if (result.exitCode === 1) {
              return false;
            }
            return yield* Effect.fail(
              commandError(
                ["git", "show-ref", "--verify", "--quiet", `refs/heads/${name}`],
                result.stderr.trim(),
                result.exitCode,
              ),
            );
          }),
        branchCreate: (name, ref) =>
          runGitSuccess(["branch", name, ref], options, executor).pipe(Effect.asVoid),
        revListCount: (args) =>
          Effect.gen(function* () {
            const stdout = yield* runGitSuccess(
              ["rev-list", "--count", ...args],
              options,
              executor,
            );
            const trimmed = stdout.trim();
            const count = Number(trimmed);
            if (!Number.isFinite(count)) {
              return yield* Effect.fail(
                commandError(
                  ["git", "rev-list", "--count", ...args],
                  `unexpected non-numeric stdout: ${trimmed}`,
                ),
              );
            }
            return count;
          }),
      };
    }),
  );
