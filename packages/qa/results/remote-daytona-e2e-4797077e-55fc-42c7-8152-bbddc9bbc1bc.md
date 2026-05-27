# Result: Remote Daytona E2E

**Status:** PASS
**Test Run:** 4797077e-55fc-42c7-8152-bbddc9bbc1bc
**Scratch Issue:** SWYRD-oxtgubpx
**Branch:** symphony/e2e/oxtgubpxnsggmakxrlqheesqlnkocifp
**PR:** https://github.com/fiberplane/switchyard/pull/3
**Sandbox:** cf529be7-3c1b-4a97-9269-ca7593e2821f

## Verification

- fp REST scratch issue reached `status=done` and `symphony_state=end`.
- GitHub PR URL, number, branch, head SHA, and pinned base SHA matched fp metadata.
- Sandbox git remote/config inspection contained no registered secret values.
- Daytona sandbox labels matched `app=symphony-test`, `source=remote-daytona`, and the test run id.
- Exact-value secret scan passed for inspected orchestrator result, transcript, fp JSON, and PR JSON.
