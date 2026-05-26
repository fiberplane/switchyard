# fp REST Properties Spike

Date: 2026-05-26
Issue: `SWYRD-sybsiyeh`
Status: Passed for REST no-clone reads, writes, read-back, and comments.

## Environment

- `fp` version: `0.23.0 (f358465)`.
- Workdir: `/tmp/switchyard-fp-rest-spike-7C3cEM`.
- Scratch issue: `SWYRD-nlmpclws`.
- Scratch title:
  `remote fp REST property spike 75956213-ba41-4ecf-970f-eab8ab5d76e0`.
- Environment source: `apps/symphony-orchestrator/.env`, loaded by the shell without printing
  values.
- Required REST variables were present: `FP_REMOTE=rest-api`, `FP_TOKEN`, `FP_SERVER_URL`,
  `FP_WORKSPACE`, `FP_PROJECT_ID`; `FP_PROJECT_PREFIX` was optional.
- Local extension registration was updated in `.fp/extensions/symphony-state.ts` during this
  ticket so the project extension matches the active fp boundary: `symphony_artifact` is no
  longer registered, and the worker-owned PR metadata properties are registered as text fields.

## Non-Repo Check

The spike ran outside this repository:

```bash
cd /tmp/switchyard-fp-rest-spike-7C3cEM
git rev-parse --show-toplevel
find "$PWD" -name .fp -print -quit
```

Result:

- `git rev-parse --show-toplevel` failed as expected.
- No `.fp` directory existed under the temp workdir.

The upward `.fp` check also passed:

```bash
d="$PWD"
found=0
while [ "$d" != "/" ]; do
  if [ -e "$d/.fp" ]; then
    found=1
    break
  fi
  d="$(dirname "$d")"
done
test "$found" -eq 0
```

Result: `upward_fp_found=0`.

Sanitized REST env shape from the same temp workdir:

```bash
env | rg '^FP_(REMOTE|WORKSPACE|PROJECT_ID|PROJECT_PREFIX|SERVER_URL)='
```

Result:

```text
FP_REMOTE=rest-api
FP_SERVER_URL=[configured]
FP_WORKSPACE=[configured]
FP_PROJECT_ID=[configured]
FP_PROJECT_PREFIX=[configured]
```

`FP_TOKEN` was checked for presence but was not printed.

## Red Checks

Missing-token REST mode was checked with an isolated `HOME`, preserving only non-secret project
context:

```bash
env -i \
  PATH="$PATH" \
  HOME="$EMPTY_HOME" \
  FP_REMOTE=rest-api \
  FP_SERVER_URL="$FP_SERVER_URL" \
  FP_WORKSPACE="$FP_WORKSPACE" \
  FP_PROJECT_ID="$FP_PROJECT_ID" \
  FP_PROJECT_PREFIX="${FP_PROJECT_PREFIX:-}" \
  fp issue show SWYRD-sybsiyeh --format json
```

Result: exit `1`, empty stdout, stderr reported `No auth token found` and suggested setting
`FP_TOKEN`. No token value was printed.

Unsupported property behavior was checked with a clearly throwaway key:

```bash
fp issue update \
  SWYRD-nlmpclws \
  --property swyrd_unregistered_spike_75956213-ba41-4ecf-970f-eab8ab5d76e0=value
```

Result: exit `0`. This fp/project setup accepts arbitrary custom property keys over REST; the
throwaway property read back as `value`. This means the spike does not prove registration
enforcement. It does prove unsupported-key attempts are non-secret and visible.

## Green Path

The scratch issue was created from the non-repo REST workdir:

```bash
fp issue create \
  --title "remote fp REST property spike 75956213-ba41-4ecf-970f-eab8ab5d76e0" \
  --description "Disposable Switchyard REST custom-property spike. Safe to delete after SWYRD-sybsiyeh evidence review." \
  --format json
```

Read path:

```bash
fp issue show SWYRD-nlmpclws --format json
```

Result: exit `0`, issue JSON decoded, with `displayId=SWYRD-nlmpclws`.

Canonical property write:

```bash
fp issue update SWYRD-nlmpclws \
  --property symphony_state=active \
  --property symphony_ready=true \
  --property symphony_attempt=2 \
  --property symphony_last_error="spike sentinel last error" \
  --property symphony_branch=symphony/fp-rest-spike \
  --property symphony_pr_url=https://github.com/fiberplane/switchyard/pull/999999 \
  --property symphony_pr_number=999999 \
  --property symphony_base_sha=0123456789abcdef0123456789abcdef01234567 \
  --property symphony_head_sha=89abcdef0123456789abcdef0123456789abcdef \
  --property symphony_run_id=swy-spike-run-75956213 \
  --property symphony_sandbox_id=sb-spike-75956213 \
  --comment "SWYRD-sybsiyeh disposable REST no-clone spike wrote canonical symphony properties from a non-repo workdir."
```

Read-back result:

| Property | Value |
| --- | --- |
| `symphony_state` | `active` |
| `symphony_ready` | `true` |
| `symphony_attempt` | `2` |
| `symphony_last_error` | `spike sentinel last error` |
| `symphony_branch` | `symphony/fp-rest-spike` |
| `symphony_pr_url` | `https://github.com/fiberplane/switchyard/pull/999999` |
| `symphony_pr_number` | `999999` |
| `symphony_base_sha` | `0123456789abcdef0123456789abcdef01234567` |
| `symphony_head_sha` | `89abcdef0123456789abcdef0123456789abcdef` |
| `symphony_run_id` | `swy-spike-run-75956213` |
| `symphony_sandbox_id` | `sb-spike-75956213` |

The old `symphony_artifact` property was not written and was absent from the final issue JSON.
The new path does not require it.

Final evidence comment was written from a temp file:

```bash
fp comment SWYRD-nlmpclws --file final-comment.md
```

Result: exit `0`, comment added.

## Conclusion

`fp` REST no-clone mode can create an issue, show an issue, update all canonical `symphony_*`
properties, read them back exactly, and add a comment from a temp file without a repository checkout.
This unblocks worker-owned fp metadata writes for the remote Daytona E2E ticket.

The one caveat is property registration enforcement: the project accepted an unsupported throwaway
property key. That is not a blocker for Switchyard because the worker contract writes the canonical
keys only, and host-side decoding rejects the retired `symphony_artifact` key.

The initial review for this spike found stale local extension registration: the extension still
registered `symphony_artifact` and did not register the new PR metadata keys. That was fixed in
this ticket before closure. The REST no-clone spike itself still ran from a temp workdir without
access to `.fp`, so the green result is evidence for REST behavior rather than local extension
loading.
