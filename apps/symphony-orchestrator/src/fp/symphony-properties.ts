import { Either, Schema } from "effect";

export const SymphonyStateSchema = Schema.Literal("idle", "active", "end", "needs-attention");
export type SymphonyState = Schema.Schema.Type<typeof SymphonyStateSchema>;

export const SymphonyReadySchema = Schema.Literal("true", "false");
export type SymphonyReady = Schema.Schema.Type<typeof SymphonyReadySchema>;

export type SymphonyProperties = {
  readonly symphony_state: SymphonyState;
  readonly symphony_ready: SymphonyReady;
  readonly symphony_attempt: string | undefined;
  readonly symphony_artifact: string | undefined;
  readonly symphony_last_error: string | undefined;
};

// Locked defaults match the eligibility decision-table row 3 ("idle" + "false" = not gated).
// See docs/architecture/fp-boundary.md.
export const SYMPHONY_PROPERTIES_DEFAULTS: SymphonyProperties = {
  symphony_state: "idle",
  symphony_ready: "false",
  symphony_attempt: undefined,
  symphony_artifact: undefined,
  symphony_last_error: undefined,
};

export type DecodeFailureReason =
  | "invalid-symphony-state"
  | "invalid-symphony-ready"
  | "invalid-symphony-attempt"
  | "invalid-symphony-artifact"
  | "invalid-symphony-last-error";

const decodeLiteral = <A>(
  schema: Schema.Schema<A, A>,
  value: unknown,
  reason: DecodeFailureReason,
): Either.Either<A, DecodeFailureReason> =>
  Either.mapLeft(Schema.decodeUnknownEither(schema)(value), () => reason);

const decodeOptionalString = (
  value: unknown,
  reason: DecodeFailureReason,
): Either.Either<string | undefined, DecodeFailureReason> => {
  if (value === undefined) {
    return Either.right(undefined);
  }
  return typeof value === "string" ? Either.right(value) : Either.left(reason);
};

export const decodeSymphonyProperties = (
  open: Record<string, unknown>,
): Either.Either<SymphonyProperties, DecodeFailureReason> => {
  const stateRaw = open["symphony_state"];
  const state =
    stateRaw === undefined
      ? Either.right(SYMPHONY_PROPERTIES_DEFAULTS.symphony_state)
      : decodeLiteral(SymphonyStateSchema, stateRaw, "invalid-symphony-state");
  if (Either.isLeft(state)) {
    return Either.left(state.left);
  }

  const readyRaw = open["symphony_ready"];
  const ready =
    readyRaw === undefined
      ? Either.right(SYMPHONY_PROPERTIES_DEFAULTS.symphony_ready)
      : decodeLiteral(SymphonyReadySchema, readyRaw, "invalid-symphony-ready");
  if (Either.isLeft(ready)) {
    return Either.left(ready.left);
  }

  const attempt = decodeOptionalString(open["symphony_attempt"], "invalid-symphony-attempt");
  if (Either.isLeft(attempt)) {
    return Either.left(attempt.left);
  }

  const artifact = decodeOptionalString(open["symphony_artifact"], "invalid-symphony-artifact");
  if (Either.isLeft(artifact)) {
    return Either.left(artifact.left);
  }

  const lastError = decodeOptionalString(
    open["symphony_last_error"],
    "invalid-symphony-last-error",
  );
  if (Either.isLeft(lastError)) {
    return Either.left(lastError.left);
  }

  return Either.right({
    symphony_state: state.right,
    symphony_ready: ready.right,
    symphony_attempt: attempt.right,
    symphony_artifact: artifact.right,
    symphony_last_error: lastError.right,
  });
};
