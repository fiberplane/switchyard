import { Either, Schema } from "effect";

export const SymphonyStateSchema = Schema.Literal("idle", "active", "end", "needs-attention");
export type SymphonyState = Schema.Schema.Type<typeof SymphonyStateSchema>;

export const SymphonyReadySchema = Schema.Literal("true", "false");
export type SymphonyReady = Schema.Schema.Type<typeof SymphonyReadySchema>;

export type SymphonyProperties = {
  readonly symphony_state: SymphonyState;
  readonly symphony_ready: SymphonyReady;
  readonly symphony_attempt: string | undefined;
  readonly symphony_last_error: string | undefined;
  readonly symphony_branch: string | undefined;
  readonly symphony_pr_url: string | undefined;
  readonly symphony_pr_number: string | undefined;
  readonly symphony_base_sha: string | undefined;
  readonly symphony_head_sha: string | undefined;
  readonly symphony_run_id: string | undefined;
  readonly symphony_sandbox_id: string | undefined;
};

// Locked defaults match the eligibility decision-table row 3 ("idle" + "false" = not gated).
// See docs/architecture/fp-boundary.md.
export const SYMPHONY_PROPERTIES_DEFAULTS: SymphonyProperties = {
  symphony_state: "idle",
  symphony_ready: "false",
  symphony_attempt: undefined,
  symphony_last_error: undefined,
  symphony_branch: undefined,
  symphony_pr_url: undefined,
  symphony_pr_number: undefined,
  symphony_base_sha: undefined,
  symphony_head_sha: undefined,
  symphony_run_id: undefined,
  symphony_sandbox_id: undefined,
};

export type DecodeFailureReason =
  | "invalid-symphony-state"
  | "invalid-symphony-ready"
  | "invalid-symphony-attempt"
  | "forbidden-symphony-artifact"
  | "invalid-symphony-last-error"
  | "invalid-symphony-branch"
  | "invalid-symphony-pr-url"
  | "invalid-symphony-pr-number"
  | "invalid-symphony-base-sha"
  | "invalid-symphony-head-sha"
  | "invalid-symphony-run-id"
  | "invalid-symphony-sandbox-id";

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

  if (open["symphony_artifact"] !== undefined) {
    return Either.left("forbidden-symphony-artifact");
  }

  const lastError = decodeOptionalString(
    open["symphony_last_error"],
    "invalid-symphony-last-error",
  );
  if (Either.isLeft(lastError)) {
    return Either.left(lastError.left);
  }

  const branch = decodeOptionalString(open["symphony_branch"], "invalid-symphony-branch");
  if (Either.isLeft(branch)) {
    return Either.left(branch.left);
  }

  const prUrl = decodeOptionalString(open["symphony_pr_url"], "invalid-symphony-pr-url");
  if (Either.isLeft(prUrl)) {
    return Either.left(prUrl.left);
  }

  const prNumber = decodeOptionalString(open["symphony_pr_number"], "invalid-symphony-pr-number");
  if (Either.isLeft(prNumber)) {
    return Either.left(prNumber.left);
  }

  const baseSha = decodeOptionalString(open["symphony_base_sha"], "invalid-symphony-base-sha");
  if (Either.isLeft(baseSha)) {
    return Either.left(baseSha.left);
  }

  const headSha = decodeOptionalString(open["symphony_head_sha"], "invalid-symphony-head-sha");
  if (Either.isLeft(headSha)) {
    return Either.left(headSha.left);
  }

  const runId = decodeOptionalString(open["symphony_run_id"], "invalid-symphony-run-id");
  if (Either.isLeft(runId)) {
    return Either.left(runId.left);
  }

  const sandboxId = decodeOptionalString(
    open["symphony_sandbox_id"],
    "invalid-symphony-sandbox-id",
  );
  if (Either.isLeft(sandboxId)) {
    return Either.left(sandboxId.left);
  }

  return Either.right({
    symphony_state: state.right,
    symphony_ready: ready.right,
    symphony_attempt: attempt.right,
    symphony_last_error: lastError.right,
    symphony_branch: branch.right,
    symphony_pr_url: prUrl.right,
    symphony_pr_number: prNumber.right,
    symphony_base_sha: baseSha.right,
    symphony_head_sha: headSha.right,
    symphony_run_id: runId.right,
    symphony_sandbox_id: sandboxId.right,
  });
};
