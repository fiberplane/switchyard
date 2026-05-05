# Vertical Slice Dogfood - Real Issue

Date: 2026-05-05
Runner: Codex in `/Users/brettbeutell/fiber/switchyard`

## Run Inputs

- Verification issue: `SWYRD-mnyajzed`
- Dispatched fp issue: `SWYRD-djqqblyi`
- Internal issue id: `djqqblyimbyyexfemfgkmcbjaxgjbajg`
- Host baseRev: `7aaef48f3d732f06010404685e0155815a5045da`
- Workflow file: `./WORKFLOW.md`
- Daytona snapshot: `symphony-test-codex`
- Sandbox id: `249a12bf-3123-4876-92d4-7495de459e46`
- Sandbox Codex version: `codex-cli 0.128.0`

## Result

The orchestrator dispatched the real fp issue, created a Daytona sandbox, drove a real Codex turn,
downloaded artifacts, integrated a branch, and marked the issue done.

- Final fp status: `done`
- Final fp properties: `symphony_state=end`, `symphony_attempt=1`,
  `symphony_artifact=symphony/djqqblyimbyyexfemfgkmcbjaxgjbajg`
- Branch: `symphony/djqqblyimbyyexfemfgkmcbjaxgjbajg`
- Branch head: `6ad8bfebaef8630c4b885246a316e9d7b3fad6ac`
- Worker commit: `6ad8bfe SWYRD-djqqblyi document retention policy`

Artifacts captured here:

- `orchestrator.log` - empty; see findings.
- `outcome.json`
- `outcome-record.json`
- `transcript-sample.jsonl`

Full run artifacts remain in:

`.symphony/runs/runs/djqqblyimbyyexfemfgkmcbjaxgjbajg/1/`

## Evidence

`outcome-record.json` recorded:

```json
{
  "status": "integrated",
  "branch": "symphony/djqqblyimbyyexfemfgkmcbjaxgjbajg",
  "baseRev": "7aaef48f3d732f06010404685e0155815a5045da",
  "workerStatus": "completed",
  "attempt": 1
}
```

Transcript sample confirms the Codex protocol reached `thread/start` with:

- `approvalPolicy: "never"`
- `sandbox: "danger-full-access"`
- `cwd: "/workspace/repo"`

The fp comment cadence was present:

1. `Dispatched to sandbox ...`
2. `Worker turn completed; integrating`
3. Worker summary from `outcome.json`

## Findings

Lifecycle passed, but the branch is not cleanly rooted at the host `baseRev`. The sandbox setup
creates a synthetic `base` commit from the source archive, so the resulting bundle imports worker
history on top of that synthetic root. In this real repo, `git diff <host-base>..branch` showed
unrelated-history noise including `.fp` deletions, even though the worker's own commit was focused
on `docs/README.md` and `docs/architecture/retention-policy.md`.

Backport/follow-up: `SWYRD-yailwgkj` now has a comment with this evidence. Full host git history
transfer is required before dogfood branches are safe to treat as directly integratable.

The structured JSON log surface also did not emit run events; `orchestrator.log` is zero bytes.
The lifecycle was debuggable via fp comments, run artifacts, and Daytona inspection, but the
`SWYRD-ozdpzajz` observability contract needs a follow-up to add issue-scoped log events around
claim, sandbox creation, turn completion, integration, and completion.

Worker quality was acceptable for the selected policy-doc issue: it added a focused architecture
doc and updated `docs/README.md`. The worker could not run repo gates inside the sandbox because
the snapshot lacks `bun` and `drift`; that should feed into future snapshot design if we expect
workers to self-verify Switchyard tasks.
