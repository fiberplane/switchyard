#!/bin/sh
# Thin wrapper around `docker compose` for the local Daytona stack the
# orchestrator dispatches against.
#
# This is the dogfood/demo stack — distinct from the integration-test stack
# at `../test/daytona/compose.sh`. The two stacks bind different host ports
# (3000-range vs 33000-range) and use different snapshots, so they can run
# side-by-side if you want.
#
# Usage (typically via package.json scripts):
#   apps/symphony-orchestrator/daytona/compose.sh up -d
#   apps/symphony-orchestrator/daytona/compose.sh down -v
#   apps/symphony-orchestrator/daytona/compose.sh logs api
#   apps/symphony-orchestrator/daytona/compose.sh config
#
# The vendored compose already bakes in macOS-safe proxy URLs (nip.io), so
# no Darwin overlay is needed today. If a future divergence requires one,
# branch here on `uname` like the test stack's wrapper.

set -eu

dir="$(cd "$(dirname "$0")" && pwd)"

# Paths with whitespace mangle docker-compose's arg list. Fail fast rather
# than hand the operator a confusing "compose file not found" later.
case "$dir" in
  *' '*)
    printf 'compose.sh: %s contains whitespace; docker-compose args do not survive word-splitting. Move the repo to a path without spaces and retry.\n' "$dir" >&2
    exit 1
    ;;
esac

exec docker compose -p switchyard-daytona \
  -f "$dir/compose.yaml" \
  "$@"
