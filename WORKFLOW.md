# Workflow config.
#
# See WORKFLOW.example.md for an annotated reference. Keep this file tracked and
# secret-free. Daytona, GitHub, fp, and Codex credentials come from
# apps/symphony-orchestrator/.env or the host process environment.

tracker:
  kind: fp
  dispatchFilter:
    property: symphony_ready
    value: "true"

polling:
  intervalMs: 5000

agent:
  maxConcurrentAgents: 1
  maxAttempts: 1

sandbox:
  kind: daytona
  snapshot: symphony-codex-bun
  language: typescript
  autoStopInterval: 15
  autoDeleteInterval: -1
  repoPath: /workspace/repo
  sourceStrategy: archive
  artifactStrategy: bundle

codex:
  command: codex app-server
  turnTimeoutMs: 3600000

integration:
  branchPrefix: symphony/
