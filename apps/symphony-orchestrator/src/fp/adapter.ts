import { Command, CommandExecutor } from "@effect/platform";
import { Context, Effect, Layer } from "effect";

import { FpBinaryNotFoundError, FpCommandError, FpDecodeError } from "./errors.js";
import { FpBinary, type FpBinaryShape } from "./binary.js";
import {
  decodeFpIssueDetailJson,
  decodeFpIssueListJson,
  type FpIssue,
  type FpIssueDetail,
  type FpIssueStatus,
} from "./models.js";

export type FpAdapterOptions = {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
};

export type FpAdapterShape = {
  readonly listIssuesByStatus: (
    status: FpIssueStatus,
  ) => Effect.Effect<readonly FpIssue[], FpBinaryNotFoundError | FpCommandError | FpDecodeError>;
  readonly showIssue: (
    id: string,
  ) => Effect.Effect<FpIssueDetail, FpBinaryNotFoundError | FpCommandError | FpDecodeError>;
};

export class FpAdapter extends Context.Tag("FpAdapter")<FpAdapter, FpAdapterShape>() {}

const currentCwd = (options: FpAdapterOptions): string => options.cwd ?? process.cwd();

const currentEnv = (options: FpAdapterOptions): Record<string, string | undefined> =>
  options.env ?? process.env;

const commandError = (command: readonly string[], stderr: string, exitCode = -1): FpCommandError =>
  new FpCommandError({
    command,
    stderr,
    exitCode,
  });

const runFpCommand = (
  args: readonly string[],
  options: FpAdapterOptions,
  fpBinary: FpBinaryShape,
  executor: CommandExecutor.CommandExecutor,
): Effect.Effect<string, FpBinaryNotFoundError | FpCommandError> =>
  Effect.gen(function* () {
    const binaryPath = yield* fpBinary.resolve();
    const commandParts = [binaryPath, ...args];
    const command = Command.make(binaryPath, ...args).pipe(
      Command.workingDirectory(currentCwd(options)),
      Command.env(currentEnv(options)),
    );

    return yield* executor.string(command).pipe(
      Effect.catchTags({
        BadArgument: (error) => Effect.fail(commandError(commandParts, error.message)),
        SystemError: (error) => Effect.fail(commandError(commandParts, error.message)),
      }),
    );
  });

export const FpAdapterLive = (options: FpAdapterOptions = {}) =>
  Layer.effect(
    FpAdapter,
    Effect.gen(function* () {
      const fpBinary = yield* FpBinary;
      const executor = yield* CommandExecutor.CommandExecutor;

      return {
        listIssuesByStatus: (status) =>
          runFpCommand(
            ["issue", "list", "--status", status, "--format", "json"],
            options,
            fpBinary,
            executor,
          ).pipe(
            Effect.flatMap((output) =>
              decodeFpIssueListJson(output, `fp issue list --status ${status} --format json`),
            ),
          ),
        showIssue: (id) =>
          runFpCommand(["issue", "show", id, "--format", "json"], options, fpBinary, executor).pipe(
            Effect.flatMap((output) => decodeFpIssueDetailJson(output, `fp issue show ${id}`)),
          ),
      };
    }),
  );
