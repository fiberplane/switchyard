# Remote Daytona Cleanup Selectors

## Goal

Understand the labels that make remote Daytona E2E cleanup precise.

## Labels

Remote E2E sandboxes use:

```text
app=symphony-test
source=remote-daytona
test_run_id=<uuid>
owner=<operator-or-default>
```

Normal orchestrator dispatches use run labels such as:

```text
app=symphony
fp_issue_id=<internal-fp-id>
fp_display_id=<display-id>
run_id=<switchyard-run-id>
```

## Verification

The E2E runner lists sandboxes by labels, validates every candidate before deletion, and polls
until the matching set is empty. It refuses cleanup if `test_run_id` is missing.
