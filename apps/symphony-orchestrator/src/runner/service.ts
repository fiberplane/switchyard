import { Context, Effect, Layer, Stream, type Scope } from "effect";

import {
  ProtocolFramingError,
  ProtocolParseError,
  ProtocolRecvError,
  ProtocolSendError,
  RunnerProtocolError,
  RunnerRequestError,
  RunnerRequestTimeoutError,
  RunnerSessionClosedError,
  RunnerTurnCancelledError,
  RunnerTurnFailedError,
  RunnerTurnInputRequiredError,
  RunnerTurnTimeoutError,
} from "./errors.js";
import { makeSession } from "./session.js";
import type { RunnerNotification } from "./session.js";
import type { ProtocolStream } from "./transport.js";
import { startTurn } from "./turn.js";

export type RunTurnInput = {
  readonly stream: ProtocolStream;
  readonly prompt: string;
  readonly cwd: string;
  readonly requestTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
};

export type TurnOutcome =
  | {
      readonly kind: "completed";
      readonly result: unknown;
      readonly events: ReadonlyArray<RunnerNotification>;
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly events: ReadonlyArray<RunnerNotification>;
    }
  | {
      readonly kind: "cancelled";
      readonly reason: string;
      readonly events: ReadonlyArray<RunnerNotification>;
    }
  | {
      readonly kind: "input-required";
      readonly prompt: unknown;
      readonly events: ReadonlyArray<RunnerNotification>;
    };

export type RunnerError =
  | ProtocolFramingError
  | ProtocolParseError
  | ProtocolRecvError
  | ProtocolSendError
  | RunnerProtocolError
  | RunnerRequestError
  | RunnerRequestTimeoutError
  | RunnerSessionClosedError
  | RunnerTurnTimeoutError;

export type AgentRunnerShape = {
  readonly runTurn: (input: RunTurnInput) => Effect.Effect<TurnOutcome, RunnerError, Scope.Scope>;
};

export class AgentRunner extends Context.Tag("AgentRunner")<AgentRunner, AgentRunnerShape>() {}

const completedOutcome = (
  result: unknown,
  events: ReadonlyArray<RunnerNotification>,
): TurnOutcome => ({
  kind: "completed",
  result,
  events,
});

export const runTurn = ({
  stream,
  prompt,
  cwd,
  requestTimeoutMs,
  turnTimeoutMs,
}: RunTurnInput): Effect.Effect<TurnOutcome, RunnerError, Scope.Scope> =>
  Effect.gen(function* () {
    const sessionOptions =
      requestTimeoutMs === undefined ? { stream, cwd } : { stream, cwd, requestTimeoutMs };
    const session = yield* makeSession(sessionOptions);
    const turnOptions =
      turnTimeoutMs === undefined
        ? { session, prompt, cwd }
        : { session, prompt, cwd, timeoutMs: turnTimeoutMs };
    const turn = yield* startTurn(turnOptions);
    const eventsFiber = yield* Stream.runCollect(turn.events).pipe(Effect.forkScoped);
    const events = () =>
      eventsFiber.pipe(Effect.flatMap((chunk) => Effect.succeed(Array.from(chunk))));
    return yield* turn.completed.pipe(
      Effect.flatMap((result) =>
        events().pipe(Effect.map((observed) => completedOutcome(result, observed))),
      ),
      Effect.catchTag("RunnerTurnFailedError", (error: RunnerTurnFailedError) =>
        events().pipe(
          Effect.map(
            (observed) =>
              ({ kind: "failed", reason: error.reason, events: observed }) satisfies TurnOutcome,
          ),
        ),
      ),
      Effect.catchTag("RunnerTurnCancelledError", (error: RunnerTurnCancelledError) =>
        events().pipe(
          Effect.map(
            (observed) =>
              ({ kind: "cancelled", reason: error.reason, events: observed }) satisfies TurnOutcome,
          ),
        ),
      ),
      Effect.catchTag("RunnerTurnInputRequiredError", (error: RunnerTurnInputRequiredError) =>
        events().pipe(
          Effect.map(
            (observed) =>
              ({
                kind: "input-required",
                prompt: error.prompt,
                events: observed,
              }) satisfies TurnOutcome,
          ),
        ),
      ),
    );
  });

export const AgentRunnerLive = Layer.succeed(AgentRunner, { runTurn });
