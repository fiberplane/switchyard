# fp Boundary

Status: Active. Scope: **adapter + eligibility predicate only.** The `FpService` method
surface (`fetchCandidates` / `claimIssue` / `markCompleted` / …) is intentionally **not**
specified here yet — it remains consumer-shape until the orchestrator service consumes it. A
future leaf extends this doc with the service surface once stable.

This doc is the contract for everything in `apps/symphony-orchestrator/src/fp/` **except**
`service.ts`. It links UP to the umbrella spec's `## fp Contract` section in
`docs/experiments/2026-05-04-symphony-daytona-vertical-slice.md` and DOWN to the source
files that implement it.

Cross-links:

- Umbrella spec: [`## fp Contract`](../experiments/2026-05-04-symphony-daytona-vertical-slice.md)
  (Ready Rule, Custom Properties, Writer Boundary, Status Transitions, Retry & Eligibility).
- ADR: [`0001-symphony-deviations.md`](./0001-symphony-deviations.md) — D1 (`symphony_state`
  naming), D4 (orchestrator is sole fp writer), D4b (minimal property surface), D5
  (human-gated retry).

## Custom property surface

Lifted from the umbrella spec; the source-of-truth is the extension at
`.fp/extensions/symphony-state.ts`. Five properties, no more:

| Property              | Type                                                         | Writer           | Meaning                                                                            |
| --------------------- | ------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------- |
| `symphony_ready`      | select `"true"` / `"false"`                                  | human or planner | Explicit dispatch gate.                                                            |
| `symphony_state`      | select `"idle"` / `"active"` / `"end"` / `"needs-attention"` | orchestrator     | Coarse human-glance runtime hint. **Not authoritative; not read for correctness.** |
| `symphony_attempt`    | text (numeric)                                               | orchestrator     | Current attempt number.                                                            |
| `symphony_artifact`   | text                                                         | orchestrator     | Integration branch name (e.g. `symphony/SWYRD-abc123`) and/or local artifact path. |
| `symphony_last_error` | text                                                         | orchestrator     | Last normalized failure reason.                                                    |

Decoded from `FpIssueDetail.properties` (open record) by `decodeSymphonyProperties` in
`symphony-properties.ts`. Decoding is **lenient on unknown keys** (extras dropped) and
**strict on invalid known-key literals** (returns `Left<DecodeFailureReason>`). Locked
defaults match decision-table row 3 — absent `symphony_state` reads as `"idle"`, absent
`symphony_ready` reads as `"false"`.

## Writer boundary (per ADR D4)

The orchestrator is the **sole** `fp` writer. The worker holds no `fp` credentials; the
sandbox boundary is the trust boundary. Worker intent reaches `fp` only through the
orchestrator's translation of `outcome.json`.

## Eligibility decision table

The pure predicate `isEligible` in `eligibility.ts` returns `Either<EligibleIssue,
IneligibilityReason>` and exhaustively covers all rows below. The `symphony_state` column is
**informational only** — eligibility derives from `status` + `symphony_ready` + the
orchestrator's in-memory claim set + open-children / dependency state.

| `status`      | `symphony_ready` | `symphony_state`  | Deps + children                         | Verdict | Reason on Left                                    |
| ------------- | ---------------- | ----------------- | --------------------------------------- | ------- | ------------------------------------------------- |
| `todo`        | `false`          | any               | any                                     | No      | `not-ready`                                       |
| `todo`        | `true`           | `idle`            | any non-terminal dep, OR any open child | No      | `blocked-by-dependency` / `blocked-by-open-child` |
| `todo`        | `true`           | `idle`            | all deps terminal AND no open children  | Yes     | —                                                 |
| `todo`        | `true`           | `needs-attention` | all deps terminal AND no open children  | Yes     | — (re-armed)                                      |
| `todo`        | `true`           | `needs-attention` | any non-terminal dep, OR any open child | No      | `blocked-by-dependency` / `blocked-by-open-child` |
| `in-progress` | any              | `active`          | any                                     | No      | `not-todo`                                        |
| `in-progress` | any              | `needs-attention` | any                                     | No      | `needs-attention-not-rearmed`                     |
| `done`        | any              | `end`             | any                                     | No      | `not-todo`                                        |

Additional `IneligibilityReason` values: `already-running` (id present in the orchestrator's
in-memory `runningSet`); `malformed-symphony-properties` (decode of the open property bag
returned `Left` — the candidate is excluded from the scan but does not abort it).

### `OpenIssueIndex`

Built once per scan from the union of `listIssuesByStatus("todo")` +
`listIssuesByStatus("in-progress")` and passed to `isEligible`. Encapsulates the two lookups
the predicate needs:

```ts
type OpenIssueIndex = {
  readonly ids: ReadonlySet<string>;
  readonly childrenByParent: ReadonlyMap<string, ReadonlyArray<string>>;
};
```

Because only `todo` and `in-progress` are non-terminal in fp's status model, "dep is
terminal" ≡ "dep id is absent from `OpenIssueIndex.ids`" — that equivalence is what makes the
two-phase fetch correct.

## Atomicity contract for `updateIssue`

`FpAdapter.updateIssue(id, { status?, properties?, comment? })` wraps a single
`fp issue update <id>` invocation that combines `--status`, repeated `--property k=v` flags,
and `--comment` into one CLI call. The semantic guarantee:

- Either every requested change lands in the same fp call, or none does and an
  `FpCommandError` propagates.
- The adapter intercepts empty input (`{}`) and returns `Effect.void` without invoking fp,
  because fp rejects updates with no changes.
- The original `setStatus` / `setProperty` / `addComment` methods are preserved alongside
  `updateIssue` for callers that genuinely want a single-purpose write. The semantic service
  layer composes via `updateIssue` only.

Atomic-intent verification at the test boundary: service-with-fake-adapter tests record every
call to every method on `FpAdapterShape` and assert both **presence** of the expected
`updateIssue` call and **absence** of `setStatus` / `setProperty` / `addComment` after
`updateIssue` is the contract. See `apps/symphony-orchestrator/test/fp/service.test.ts`.

## N+1 fetch — expected v1 behavior

The Ready-Rule implementation runs a per-`todo`-candidate `showIssue` after the two
`listIssuesByStatus` calls (because list output omits custom properties). This is **expected
v1 behavior** for this slice. A follow-up to investigate an `fp issue list` extension that
returns properties inline is tracked as `SWYRD-jmxexmkw`.

The cost is bounded by the number of `todo` issues, which for the demo's scale (single-digit
candidates per tick) is acceptable. If `fetchCandidates` becomes a hot path before the
optimization lands, raise this concern on `SWYRD-jmxexmkw`.

## Source bindings

`drift link`ed source files (managed via `drift.lock`):

- [`adapter.ts`](../../apps/symphony-orchestrator/src/fp/adapter.ts) — `FpAdapter`
  Effect service, `FpAdapterLive` layer, `updateIssue` and the original four CLI methods.
- [`models.ts`](../../apps/symphony-orchestrator/src/fp/models.ts) — Schema + decode helpers
  for `FpIssue` / `FpIssueDetail` (the open `properties` bag is decoded by
  `symphony-properties.ts`).
- [`errors.ts`](../../apps/symphony-orchestrator/src/fp/errors.ts) — `FpBinaryNotFoundError`,
  `FpCommandError`, `FpDecodeError`.
- [`symphony-properties.ts`](../../apps/symphony-orchestrator/src/fp/symphony-properties.ts)
  — typed view + decode of the `symphony_*` property surface.
- [`eligibility.ts`](../../apps/symphony-orchestrator/src/fp/eligibility.ts) — pure
  `isEligible` predicate, `IneligibilityReason` union, `OpenIssueIndex`,
  `buildOpenIssueIndex`.

`service.ts` is **deliberately NOT** linked here — its method surface is consumer-shape and
not yet stable. The next consumer (orchestrator service leaf) extends this doc with the
service surface and adds its `drift link`.
