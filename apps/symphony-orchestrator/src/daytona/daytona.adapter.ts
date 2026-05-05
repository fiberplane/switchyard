import { Buffer } from "node:buffer";

import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import { Context, Effect, Layer, ParseResult, Schema } from "effect";

import {
  DaytonaSandboxCreateError,
  DaytonaSandboxNotFoundError,
  DaytonaSandboxOpError,
  DaytonaSnapshotError,
} from "./errors.js";
import type {
  DaytonaCommandOptions,
  DaytonaCommandResult,
  DaytonaConfig,
  DaytonaFileTransfer,
  DaytonaSandboxSpec,
  SandboxHandle,
} from "./models.js";

export type DaytonaAdapterShape = {
  readonly assertSnapshot: (name: string) => Effect.Effect<void, DaytonaSnapshotError>;
  readonly createSandbox: (
    spec: DaytonaSandboxSpec,
  ) => Effect.Effect<SandboxHandle, DaytonaSandboxCreateError>;
  readonly deleteSandbox: (
    handle: SandboxHandle,
  ) => Effect.Effect<void, DaytonaSandboxNotFoundError | DaytonaSandboxOpError>;
  readonly executeCommand: (
    handle: SandboxHandle,
    command: string,
    options?: DaytonaCommandOptions,
  ) => Effect.Effect<DaytonaCommandResult, DaytonaSandboxNotFoundError | DaytonaSandboxOpError>;
  readonly uploadFiles: (
    handle: SandboxHandle,
    files: readonly DaytonaFileTransfer[],
  ) => Effect.Effect<void, DaytonaSandboxNotFoundError | DaytonaSandboxOpError>;
  readonly downloadFiles: (
    handle: SandboxHandle,
    files: readonly DaytonaFileTransfer[],
  ) => Effect.Effect<void, DaytonaSandboxNotFoundError | DaytonaSandboxOpError>;
};

export class DaytonaAdapter extends Context.Tag("DaytonaAdapter")<
  DaytonaAdapter,
  DaytonaAdapterShape
>() {}

export type DaytonaAdapterOptions = {
  readonly probeOnInit?: boolean;
};

const describeUnknown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const isDaytonaNotFound = (error: unknown): boolean => {
  if (error instanceof DaytonaNotFoundError) {
    return true;
  }
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    return error.statusCode === 404;
  }
  return error instanceof Error && error.message.toLowerCase().includes("not found");
};

const isStateChangeInProgress = (error: unknown): boolean =>
  error instanceof Error && error.message.toLowerCase().includes("state change in progress");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const CommandEnvelopeSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdoutBase64: Schema.String,
  stderrBase64: Schema.String,
});

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const buildCommandEnvelope = (command: string): string =>
  [
    "stdout_file=$(mktemp)",
    "stderr_file=$(mktemp)",
    `bash -lc ${shellQuote(command)} >"$stdout_file" 2>"$stderr_file"`,
    "status=$?",
    'printf \'{"exitCode":%s,"stdoutBase64":"\' "$status"',
    'base64 -w 0 "$stdout_file"',
    'printf \'","stderrBase64":"\'',
    'base64 -w 0 "$stderr_file"',
    "printf '\"}\\n'",
    'rm -f "$stdout_file" "$stderr_file"',
    "exit 0",
  ].join("\n");

const decodeCommandEnvelope = (
  sandboxId: string,
  content: string,
): Effect.Effect<DaytonaCommandResult, DaytonaSandboxOpError> =>
  Schema.decodeUnknown(Schema.parseJson(CommandEnvelopeSchema))(content).pipe(
    Effect.map((envelope) => ({
      exitCode: envelope.exitCode,
      stdout: Buffer.from(envelope.stdoutBase64, "base64").toString("utf8"),
      stderr: Buffer.from(envelope.stderrBase64, "base64").toString("utf8"),
    })),
    Effect.catchTag("ParseError", (error) =>
      Effect.fail(
        new DaytonaSandboxOpError({
          operation: "executeCommand",
          sandboxId,
          reason: `command envelope decode failed: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
        }),
      ),
    ),
  );

const createDaytonaClient = (config: DaytonaConfig): Daytona =>
  new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    target: config.target,
    _experimental: {
      otelEnabled: false,
    },
  });

const probeDaytonaClient = (client: Daytona): Effect.Effect<void, DaytonaSandboxOpError> =>
  Effect.tryPromise({
    try: async () => {
      await client.snapshot.list(1, 1);
    },
    catch: (error) =>
      new DaytonaSandboxOpError({
        operation: "snapshot.list",
        reason: describeUnknown(error),
      }),
  }).pipe(Effect.asVoid);

const assertSnapshot = (client: Daytona, name: string): Effect.Effect<void, DaytonaSnapshotError> =>
  Effect.tryPromise({
    try: () => client.snapshot.get(name),
    catch: (error) =>
      new DaytonaSnapshotError({
        snapshotName: name,
        reason: describeUnknown(error),
      }),
  }).pipe(
    Effect.flatMap((snapshot) => {
      if (snapshot.state === "active") {
        return Effect.void;
      }

      return Effect.fail(
        new DaytonaSnapshotError({
          snapshotName: name,
          state: String(snapshot.state),
          reason: "expected active snapshot",
        }),
      );
    }),
    Effect.withSpan("DaytonaAdapter.assertSnapshot"),
  );

const createSandbox = (
  client: Daytona,
  spec: DaytonaSandboxSpec,
): Effect.Effect<SandboxHandle, DaytonaSandboxCreateError> =>
  Effect.tryPromise({
    try: async () => {
      const labels = { ...spec.labels };
      const envVars = { ...spec.envVars };
      const sandbox = await client.create(
        {
          name: spec.name,
          snapshot: spec.snapshotName,
          language: spec.language,
          labels: { ...labels },
          envVars: { ...envVars },
          autoStopInterval: spec.autoStopInterval,
          autoDeleteInterval: spec.autoDeleteInterval,
        },
        { timeout: spec.createTimeoutSec ?? 300 },
      );

      return {
        id: sandbox.id,
        name: sandbox.name,
        labels,
        envVars,
      };
    },
    catch: (error) =>
      new DaytonaSandboxCreateError({
        sandboxName: spec.name,
        reason: describeUnknown(error),
      }),
  }).pipe(Effect.withSpan("DaytonaAdapter.createSandbox"));

const getSandbox = (
  client: Daytona,
  sandboxId: string,
  operation: string,
): Effect.Effect<Sandbox, DaytonaSandboxNotFoundError | DaytonaSandboxOpError> =>
  Effect.tryPromise({
    try: () => client.get(sandboxId),
    catch: (error) => {
      if (isDaytonaNotFound(error)) {
        return new DaytonaSandboxNotFoundError({
          sandboxId,
          operation,
          reason: describeUnknown(error),
        });
      }

      return new DaytonaSandboxOpError({
        operation,
        sandboxId,
        reason: describeUnknown(error),
      });
    },
  }).pipe(
    Effect.flatMap((sandbox) => {
      if (sandbox.state === "destroyed") {
        return Effect.fail(
          new DaytonaSandboxNotFoundError({
            sandboxId,
            operation,
            reason: "sandbox is destroyed",
          }),
        );
      }

      return Effect.succeed(sandbox);
    }),
  );

const deleteSandbox = (
  client: Daytona,
  handle: SandboxHandle,
): Effect.Effect<void, DaytonaSandboxNotFoundError | DaytonaSandboxOpError> =>
  getSandbox(client, handle.id, "deleteSandbox").pipe(
    Effect.flatMap((sandbox) =>
      Effect.tryPromise({
        try: () => sandbox.delete(120),
        catch: (error) => {
          if (isDaytonaNotFound(error)) {
            return new DaytonaSandboxNotFoundError({
              sandboxId: handle.id,
              operation: "deleteSandbox",
              reason: describeUnknown(error),
            });
          }

          return new DaytonaSandboxOpError({
            operation: "deleteSandbox",
            sandboxId: handle.id,
            reason: describeUnknown(error),
          });
        },
      }).pipe(
        Effect.catchAll((error) => {
          if (error instanceof DaytonaSandboxNotFoundError || isStateChangeInProgress(error)) {
            return Effect.void;
          }

          return Effect.fail(error);
        }),
      ),
    ),
    Effect.catchTag("DaytonaSandboxNotFoundError", () => Effect.void),
    Effect.zipRight(waitForSandboxDeleted(client, handle.id)),
    Effect.withSpan("DaytonaAdapter.deleteSandbox"),
  );

const waitForSandboxDeleted = (
  client: Daytona,
  sandboxId: string,
): Effect.Effect<void, DaytonaSandboxNotFoundError | DaytonaSandboxOpError> =>
  Effect.tryPromise({
    try: async () => {
      const deadline = Date.now() + 120_000;

      while (Date.now() < deadline) {
        try {
          const sandbox = await client.get(sandboxId);
          if (sandbox.state === "destroyed") {
            return;
          }
        } catch (error) {
          if (isDaytonaNotFound(error)) {
            return;
          }
          throw error;
        }

        await sleep(500);
      }

      throw new DaytonaSandboxOpError({
        operation: "deleteSandbox",
        sandboxId,
        reason: "sandbox did not reach destroyed state within 120000ms",
      });
    },
    catch: (error) => {
      if (error instanceof DaytonaSandboxOpError) {
        return error;
      }
      if (isDaytonaNotFound(error)) {
        return new DaytonaSandboxNotFoundError({
          sandboxId,
          operation: "deleteSandbox",
          reason: describeUnknown(error),
        });
      }

      return new DaytonaSandboxOpError({
        operation: "deleteSandbox",
        sandboxId,
        reason: describeUnknown(error),
      });
    },
  });

const executeCommand = (
  client: Daytona,
  handle: SandboxHandle,
  command: string,
  options: DaytonaCommandOptions = {},
): Effect.Effect<DaytonaCommandResult, DaytonaSandboxNotFoundError | DaytonaSandboxOpError> =>
  getSandbox(client, handle.id, "executeCommand").pipe(
    Effect.flatMap((sandbox) =>
      Effect.tryPromise({
        try: async () => {
          const result = await sandbox.process.executeCommand(
            buildCommandEnvelope(command),
            options.cwd,
            options.env,
            options.timeoutSec,
          );
          return result.result;
        },
        catch: (error) => {
          if (isDaytonaNotFound(error)) {
            return new DaytonaSandboxNotFoundError({
              sandboxId: handle.id,
              operation: "executeCommand",
              reason: describeUnknown(error),
            });
          }

          return new DaytonaSandboxOpError({
            operation: "executeCommand",
            sandboxId: handle.id,
            reason: describeUnknown(error),
          });
        },
      }).pipe(Effect.flatMap((content) => decodeCommandEnvelope(handle.id, content))),
    ),
    Effect.withSpan("DaytonaAdapter.executeCommand"),
  );

const uploadFiles = (
  client: Daytona,
  handle: SandboxHandle,
  files: readonly DaytonaFileTransfer[],
): Effect.Effect<void, DaytonaSandboxNotFoundError | DaytonaSandboxOpError> =>
  getSandbox(client, handle.id, "uploadFiles").pipe(
    Effect.flatMap((sandbox) =>
      Effect.tryPromise({
        try: () =>
          sandbox.fs.uploadFiles(
            files.map((file) => ({
              source: file.src,
              destination: file.dst,
            })),
          ),
        catch: (error) => {
          if (isDaytonaNotFound(error)) {
            return new DaytonaSandboxNotFoundError({
              sandboxId: handle.id,
              operation: "uploadFiles",
              reason: describeUnknown(error),
            });
          }

          return new DaytonaSandboxOpError({
            operation: "uploadFiles",
            sandboxId: handle.id,
            reason: describeUnknown(error),
          });
        },
      }),
    ),
    Effect.withSpan("DaytonaAdapter.uploadFiles"),
  );

const downloadFiles = (
  client: Daytona,
  handle: SandboxHandle,
  files: readonly DaytonaFileTransfer[],
): Effect.Effect<void, DaytonaSandboxNotFoundError | DaytonaSandboxOpError> =>
  getSandbox(client, handle.id, "downloadFiles").pipe(
    Effect.flatMap((sandbox) =>
      Effect.tryPromise({
        try: () =>
          sandbox.fs.downloadFiles(
            files.map((file) => ({
              source: file.src,
              destination: file.dst,
            })),
          ),
        catch: (error) => {
          if (isDaytonaNotFound(error)) {
            return new DaytonaSandboxNotFoundError({
              sandboxId: handle.id,
              operation: "downloadFiles",
              reason: describeUnknown(error),
            });
          }

          return new DaytonaSandboxOpError({
            operation: "downloadFiles",
            sandboxId: handle.id,
            reason: describeUnknown(error),
          });
        },
      }),
    ),
    Effect.flatMap((responses) => {
      const failed = responses.find((response) => response.error !== undefined);
      if (failed === undefined) {
        return Effect.void;
      }

      return Effect.fail(
        new DaytonaSandboxOpError({
          operation: "downloadFiles",
          sandboxId: handle.id,
          reason: `${failed.source}: ${failed.error}`,
        }),
      );
    }),
    Effect.withSpan("DaytonaAdapter.downloadFiles"),
  );

export const DaytonaAdapterLive = (config: DaytonaConfig, options: DaytonaAdapterOptions = {}) =>
  Layer.effect(
    DaytonaAdapter,
    Effect.gen(function* () {
      const client = createDaytonaClient(config);

      if (options.probeOnInit === true) {
        yield* probeDaytonaClient(client);
      }

      return {
        assertSnapshot: (name) => assertSnapshot(client, name),
        createSandbox: (spec) => createSandbox(client, spec),
        deleteSandbox: (handle) => deleteSandbox(client, handle),
        executeCommand: (handle, command, options) =>
          executeCommand(client, handle, command, options),
        downloadFiles: (handle, files) => downloadFiles(client, handle, files),
        uploadFiles: (handle, files) => uploadFiles(client, handle, files),
      };
    }),
  );
