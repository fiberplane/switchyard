import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const PositiveInteger = Schema.Number.pipe(Schema.int(), Schema.positive());
const Integer = Schema.Number.pipe(Schema.int());

export const DispatchFilter = Schema.Struct({
  property: NonEmptyString,
  value: NonEmptyString,
});
export type DispatchFilter = Schema.Schema.Type<typeof DispatchFilter>;

export const TrackerConfig = Schema.Struct({
  kind: Schema.Literal("fp"),
  dispatchFilter: DispatchFilter,
});
export type TrackerConfig = Schema.Schema.Type<typeof TrackerConfig>;

export const PollingConfig = Schema.Struct({
  intervalMs: PositiveInteger,
});
export type PollingConfig = Schema.Schema.Type<typeof PollingConfig>;

export const AgentConfig = Schema.Struct({
  maxConcurrentAgents: PositiveInteger,
  maxAttempts: Schema.Literal(1),
});
export type AgentConfig = Schema.Schema.Type<typeof AgentConfig>;

const SandboxBaseConfig = {
  kind: Schema.Literal("daytona"),
  snapshot: NonEmptyString,
  language: Schema.Literal("typescript"),
  autoStopInterval: PositiveInteger,
  autoDeleteInterval: Integer,
  repoPath: NonEmptyString,
};

export const GithubCloneSandboxConfig = Schema.Struct({
  ...SandboxBaseConfig,
  sourceStrategy: Schema.Literal("githubClone"),
  artifactStrategy: Schema.Literal("pr"),
  repoUrl: NonEmptyString,
  baseBranch: NonEmptyString,
});

export const SandboxConfig = GithubCloneSandboxConfig;
export type SandboxConfig = Schema.Schema.Type<typeof SandboxConfig>;

export const CodexSandboxPolicy = Schema.Struct({
  type: Schema.Literal("dangerFullAccess"),
});
export type CodexSandboxPolicy = Schema.Schema.Type<typeof CodexSandboxPolicy>;

export const CodexConfig = Schema.Struct({
  command: Schema.Literal("codex app-server"),
  turnTimeoutMs: PositiveInteger,
  approvalPolicy: Schema.optionalWith(Schema.Literal("never"), {
    default: () => "never" as const,
  }),
  sandbox: Schema.optionalWith(Schema.Literal("danger-full-access"), {
    default: () => "danger-full-access" as const,
  }),
  sandboxPolicy: Schema.optionalWith(CodexSandboxPolicy, {
    default: () => ({ type: "dangerFullAccess" as const }),
  }),
});
export type CodexConfig = Schema.Schema.Type<typeof CodexConfig>;

export const IntegrationConfig = Schema.Struct({
  branchPrefix: NonEmptyString,
});
export type IntegrationConfig = Schema.Schema.Type<typeof IntegrationConfig>;

export const WorkflowConfig = Schema.Struct({
  tracker: TrackerConfig,
  polling: PollingConfig,
  agent: AgentConfig,
  sandbox: SandboxConfig,
  codex: CodexConfig,
  integration: IntegrationConfig,
});
export type WorkflowConfig = Schema.Schema.Type<typeof WorkflowConfig>;
