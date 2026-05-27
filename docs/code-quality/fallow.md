# Fallow

Fallow is the repo-wide static analysis tool used for conservative dead-code,
dependency, duplicate-logic, and health triage.

Run it from the monorepo root through Bun package scripts:

```bash
bun run fallow config
bun run fallow list --plugins
bun run fallow list --entry-points
bun run fallow dead-code --format json --quiet
bun run fallow dupes --format json --quiet
bun run fallow health --score --hotspots --targets --format json --quiet
```

## Triage Policy

Fallow output is evidence, not deletion authority. Delete code only when a finding
has independent confirmation from repo-local checks such as `rg`, package scripts,
active docs, test fixtures, generated-code status, workspace entrypoints, or
public API review.

Do not delete these categories based on Fallow alone:

- generated protocol files under `apps/symphony-orchestrator/src/runner/protocol/`
- public workspace APIs or exported types that may be consumed outside the current
  static graph
- test fixtures and fixture helpers
- dynamic entrypoints such as playground scripts, QA harnesses, snapshot builders,
  or root scripts
- docs history in `docs/graveyard/` or experiment evidence
- archive/bundle runtime code unless the active architecture and tests prove the
  path has been removed

The root `.fallowrc.jsonc` keeps rules warning-only during adoption. It models
Switchyard workspaces (`apps/*`, `packages/*`, `playgrounds/*`) and active
entrypoints, then ignores generated, vendored, runtime, dependency, reference,
and build-output noise.

## Baselines

Raw JSON output is a local analysis artifact and is ignored under `.fallow/`.
Commit concise markdown summaries with command shapes, Fallow version, counts,
accepted false positives, and known modeling gaps.

When using Fallow for cleanup, record each deletion with both:

- Fallow evidence identifying the candidate
- independent proof that the file/export is not referenced by active code,
  scripts, docs, fixtures, generated-code flows, or public entrypoints

## First Baseline: SWYRD-nrmnqhhj

The first configured Switchyard run was captured after `SWYRD-lwqdsyud` retired the OSS stack.
Red state before setup: `bun run fallow config` failed with `Script not found "fallow"`.

Command suite:

```bash
bun run fallow config
bun run fallow list --plugins
bun run fallow list --entry-points
bun run fallow dead-code --format json --quiet
bun run fallow dupes --format json --quiet
bun run fallow health --score --hotspots --targets --format json --quiet
```

Baseline summary:

| Area | Count |
| --- | ---: |
| Fallow version | 2.82.0 |
| Active plugins | 2 (`oxlint`, `bun`) |
| Listed entrypoints | 65 |
| Dead-code issues in final warning-only baseline | 117 |
| Unused files | 0 |
| Unused exports before cleanup | 46 |
| Unused exports after cleanup | 43 |
| Unused types | 18 |
| Private type leaks | 5 |
| Unused class members | 47 |
| Unresolved imports | 3 |
| Duplicate exports | 1 |
| Duplicate clone groups | 4 |
| Duplicate clone instances | 13 |
| Health files analyzed | 62 |
| Health functions analyzed | 802 |
| Health functions above threshold | 45 |
| Health average maintainability | 91.3 |
| Health critical/high/moderate counts | 10 / 12 / 23 |

Cleanup performed in this pass:

| Removed code | Fallow evidence | Independent confirmation |
| --- | --- | --- |
| `DaytonaRunnerRepairError` | unused export in `apps/symphony-orchestrator/test/daytona/test-helpers/errors.ts` | `rg` found no active references after the runner-repair helper was removed |
| `DaytonaTestSnapshotError` | unused export in `apps/symphony-orchestrator/test/daytona/test-helpers/errors.ts` | `rg` found no active references after the local snapshot helper was removed |
| `DaytonaTestStackError` | unused export in `apps/symphony-orchestrator/test/daytona/test-helpers/errors.ts` | `rg` found no active references after the stack helper was removed |

No files were deleted from this baseline. Fallow reported zero unused files. The remaining export
and member findings were not independently safe deletion candidates for this ticket. The strongest
false-positive classes were public boundary schemas/types, `TaggedError.message` accessors,
unresolved root package path calculations in tests, duplicate `ProtocolStream` names in different
domains, and archive/bundle symbols that remain modeled until a later runtime removal ticket proves
the path is gone.

## Remote Daytona Closeout Rerun: SWYRD-ibmoeamq

The final remote-Daytona closeout reran the Fallow suite after the active archive/bundle runtime
APIs were removed from the orchestrator, integration, sandbox script, artifact, and test surfaces.

Command suite:

```bash
bun run fallow dead-code
bun run fallow dupes
bun run fallow health
```

Closeout summary:

| Area | Count |
| --- | ---: |
| Entry points detected | 54 |
| Unused files | 0 |
| Unused exports | 40 |
| Unused types | 19 |
| Private type leaks | 4 |
| Unused class members | 45 |
| Unresolved imports | 3 |
| Duplicate exports | 1 |
| Duplicate clone groups | 4 |
| Duplicate duplicated lines | 483 |
| Duplication percentage | 4.8% |
| Health score | 74 B |
| Health LOC analyzed | 10,037 |
| Health functions analyzed | 763 |
| Health functions above threshold | 47 |
| Health average maintainability | 91.3 |

Remaining accepted findings:

- Public schemas and exported boundary types still look unused to Fallow because the repo keeps
  schema exports available for tests, docs, and future package consumers.
- `TaggedError.message` accessors are reported as unused class members even though they are the
  human-readable error surface used by Effect and logs.
- The three unresolved imports are repo-root path calculations in tests/QA fixtures, not broken
  runtime imports.
- The duplicate `ProtocolStream` export names live in distinct Daytona-session and runner
  transport domains.
- Duplicate-code groups remain isolated to historical playground smoke/probe scripts.
- `runOneImpl` remains the main health hotspot and is tracked as the next meaningful
  decomposition target; this closeout avoided reshaping it further after deleting the retired
  archive/bundle path.
