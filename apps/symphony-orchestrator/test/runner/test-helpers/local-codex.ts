import { tmpdir } from "node:os";
import { join } from "node:path";

import { Deferred, Effect, Queue, Schema, Stream, type Scope } from "effect";

import {
  LocalCodexUnavailableError,
  ProtocolRecvError,
  ProtocolSendError,
} from "../../../src/runner/errors.js";
import type { ProtocolStream } from "../../../src/runner/transport.js";

export type LocalCodexStream = {
  readonly stream: ProtocolStream;
  readonly cwd: string;
  readonly sent: ReadonlyArray<unknown>;
};

type SpawnResult = {
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly root: string;
  readonly repoDir: string;
};

const describeUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const decodeJsonUnknown = Schema.decodeUnknownSync(Schema.parseJson(Schema.Unknown));

const copyCodexAuth = (fromPath: string, intoPath: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await Bun.write(intoPath, Bun.file(fromPath));
      await Bun.$`chmod 600 ${intoPath}`.quiet();
    },
    catch: (error) => error,
  }).pipe(Effect.ignore);

const setupRepo = (): Effect.Effect<SpawnResult, LocalCodexUnavailableError> =>
  Effect.gen(function* () {
    const codexAuthPath =
      globalThis.process.env.SWITCHYARD_CODEX_AUTH ??
      globalThis.process.env.CODEX_AUTH_JSON ??
      `${globalThis.process.env.HOME}/.codex/auth.json`;
    if (!(yield* Effect.promise(() => Bun.file(codexAuthPath).exists()))) {
      return yield* Effect.fail(
        new LocalCodexUnavailableError({
          reason: `Codex auth file not found at ${codexAuthPath}`,
        }),
      );
    }

    const root = yield* Effect.promise(() =>
      Bun.$`mktemp -d ${join(tmpdir(), "switchyard-local-codex-XXXXXX")}`.text(),
    ).pipe(Effect.map((path) => path.trim()));
    const repoDir = join(root, "repo");
    const codexHome = join(root, "codex-home");
    yield* Effect.promise(() => Bun.$`mkdir -p ${repoDir} ${codexHome}`.quiet());
    yield* copyCodexAuth(codexAuthPath, join(codexHome, "auth.json"));
    yield* Effect.promise(() => Bun.write(join(repoDir, "README.md"), "# local codex test\n"));

    const env: Record<string, string | undefined> = {
      ...globalThis.process.env,
      CODEX_HOME: codexHome,
    };
    delete env.OPENAI_API_KEY;
    delete env.SANDBOX_OPENAI_API_KEY;

    const proc = yield* Effect.try({
      try: () =>
        Bun.spawn(
          [
            globalThis.process.env.SWITCHYARD_CODEX_BIN ??
              globalThis.process.env.CODEX_BIN ??
              "codex",
            "app-server",
          ],
          {
            cwd: repoDir,
            env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          },
        ),
      catch: (error) =>
        new LocalCodexUnavailableError({
          reason: `codex app-server failed to spawn: ${describeUnknown(error)}`,
        }),
    });
    if (proc.pid === 0) {
      return yield* Effect.fail(
        new LocalCodexUnavailableError({ reason: "codex app-server failed to spawn" }),
      );
    }
    const earlyExit = yield* Effect.promise(() =>
      Promise.race<number | null>([
        proc.exited.then((exitCode) => exitCode),
        new Promise((resolve) => setTimeout(() => resolve(null), 100)),
      ]),
    );
    if (earlyExit !== null) {
      return yield* Effect.fail(
        new LocalCodexUnavailableError({
          reason: `codex app-server exited during startup: exitCode=${earlyExit}`,
        }),
      );
    }

    return { proc, root, repoDir };
  });

export const makeLocalCodexStream = (): Effect.Effect<
  LocalCodexStream,
  LocalCodexUnavailableError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Uint8Array>();
    const done = yield* Deferred.make<void, ProtocolRecvError>();
    const sent: unknown[] = [];

    const spawned = yield* Effect.acquireRelease(setupRepo(), ({ proc, root }) =>
      Effect.promise(async () => {
        proc.kill();
        await Bun.$`rm -rf ${root}`.quiet();
      }).pipe(Effect.ignore),
    );

    void (async () => {
      const exit = await spawned.proc.exited;
      Deferred.unsafeDone(
        done,
        Effect.fail(
          new ProtocolRecvError({
            reason: `local codex process exited before stdout closed: exitCode=${exit}`,
          }),
        ),
      );
    })();

    void (async () => {
      for await (const chunk of spawned.proc.stdout) {
        Queue.unsafeOffer(queue, chunk);
      }
      Deferred.unsafeDone(done, Effect.void);
    })().catch((error: unknown) => {
      Deferred.unsafeDone(
        done,
        Effect.fail(
          new ProtocolRecvError({
            reason: `local codex stdout failed: ${describeUnknown(error)}`,
          }),
        ),
      );
    });

    const receive = Stream.fromQueue(queue).pipe(
      Stream.merge(Stream.fromEffect(Deferred.await(done)).pipe(Stream.drain)),
    );

    return {
      cwd: spawned.repoDir,
      sent,
      stream: {
        send: (bytes) =>
          Effect.try({
            try: () => {
              sent.push(decodeJsonUnknown(new TextDecoder().decode(bytes)));
              spawned.proc.stdin.write(bytes);
            },
            catch: (error) =>
              new ProtocolSendError({
                reason: `local codex stdin write failed: ${describeUnknown(error)}`,
              }),
          }).pipe(Effect.asVoid),
        receive,
      },
    };
  });
