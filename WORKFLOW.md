# Local workflow config.

#

# See WORKFLOW.example.md for an annotated reference. This file targets a

# local Daytona OSS install on the host. Replace `apiKey` with the value

# generated from your local Daytona dashboard before running the orchestrator

# — the key authorizes access to localhost only and is per-machine.

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
apiUrl: http://localhost:3000/api
apiKey: dtn_b55f28870f9e9eefc5a0dbfc8c48b4832e480cfd959d58b8d510fb4e3cad693c
target: us
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
