# Remote GitHub PR

## Goal

Verify GitHub credentials can support the worker-owned PR handoff.

## Required Permission

For fine-grained PATs, grant repository access to `fiberplane/switchyard` with:

- contents read/write
- workflows read/write
- pull requests read/write

GitHub can require workflow write permission when creating a branch at a commit that already
contains `.github/workflows`.

## Preflight

Run:

```bash
bun run --filter @switchyard/qa github-token:preflight
```

The preflight prints only token fingerprints, then verifies both:

- GitHub REST create/delete-ref under `symphony/e2e/`
- isolated credential-helper-free `git push` create/delete under `symphony/e2e/`

The full E2E should not be run until both checks pass.
