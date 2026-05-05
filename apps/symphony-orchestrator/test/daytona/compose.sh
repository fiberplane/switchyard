#!/bin/sh
# Thin wrapper around `docker compose` for the switchyard-test stack.
#
# Auto-adds compose.test.macos.yaml on Darwin because *.proxy.localhost does
# not resolve on macOS. See compose.test.macos.yaml header and SWYRD-snbircyn
# for the full why.
#
# Usage (typically via package.json scripts):
#   test/daytona/compose.sh up -d
#   test/daytona/compose.sh down -v
#   test/daytona/compose.sh logs runner
#   test/daytona/compose.sh config            # verify which files are merged

set -eu

dir="$(cd "$(dirname "$0")" && pwd)"

# Paths with whitespace would mangle the docker-compose arg list. Fail fast
# rather than emit a confusing "compose file not found" later — cheaper to
# explain than to debug.
case "$dir" in
  *' '*)
    printf 'compose.sh: %s contains whitespace; docker-compose args do not survive word-splitting. Move the repo to a path without spaces and retry.\n' "$dir" >&2
    exit 1
    ;;
esac

if [ "$(uname)" = "Darwin" ]; then
  exec docker compose -p switchyard-test \
    -f "$dir/compose.test.yaml" \
    -f "$dir/compose.test.macos.yaml" \
    "$@"
fi

exec docker compose -p switchyard-test \
  -f "$dir/compose.test.yaml" \
  "$@"
