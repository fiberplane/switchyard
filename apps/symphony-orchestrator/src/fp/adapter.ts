import { Command, CommandExecutor } from "@effect/platform";
import { Chunk, Context, Effect, Layer, Stream } from "effect";

import { FpBinary, type FpBinaryShape } from "./binary.js";
import { FpBinaryNotFoundError, FpCommandError, FpDecodeError } from "./errors.js";
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
  readonly setStatus: (
    id: string,
    status: FpIssueStatus,
  ) => Effect.Effect<void, FpBinaryNotFoundError | FpCommandError>;
  readonly setProperty: (
    id: string,
    key: string,
    value: string,
  ) => Effect.Effect<void, FpBinaryNotFoundError | FpCommandError>;
  readonly addComment: (
    id: string,
    body: string,
  ) => Effect.Effect<void, FpBinaryNotFoundError | FpCommandError>;
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

        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            commandError(commandParts, result.stderr.trim(), result.exitCode),
          );
        }

        return result.stdout;
      }),
    ).pipe(
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
        setStatus: (id, status) =>
          runFpCommand(
            ["issue", "update", id, "--status", status],
            options,
            fpBinary,
            executor,
          ).pipe(Effect.asVoid),
        setProperty: (id, key, value) =>
          runFpCommand(
            ["issue", "update", id, "--property", `${key}=${value}`],
            options,
            fpBinary,
            executor,
          ).pipe(Effect.asVoid),
        addComment: (id, body) =>
          runFpCommand(["comment", "add", id, body], options, fpBinary, executor).pipe(
            Effect.asVoid,
          ),
      };
    }),
  );
