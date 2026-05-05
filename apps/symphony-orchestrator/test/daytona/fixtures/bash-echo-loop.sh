#!/usr/bin/env bash
# Read/echo/sentinel loop ported from playgrounds/symphony-daytona-playground/
# src/spike-stdio.ts:114-122. Preserved body (echo ready / read -r / echo:%s /
# sentinel exit) so cycle 5 still asserts the spike's exact round-trip.
#
# Divergence from spike: this fixture additionally emits its own PID via
# `echo $$` at startup. The PID is used by cycle 10 (force-kill via a
# side-channel DaytonaAdapter.executeCommand of `kill -9 <pid>`) to exercise
# the receive-stream's SIGKILL ⇒ DaytonaSessionLogError contract. The spike's
# loop did not need a PID side-channel.
set -u

echo "$$"
echo ready
while IFS= read -r line; do
  if [ "$line" = "__EXIT__" ]; then
    exit 0
  fi
  printf "echo:%s\n" "$line"
done
