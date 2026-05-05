// One-off warmer for the local Daytona test stack.
// Builds symphony-test-base + symphony-test-inactive so the first integration
// test run does not pay the snapshot-build cost. Idempotent — re-running on a
// warm stack is a fast metadata roundtrip.
//
// Usage: bun run test/daytona/warm.ts

import { ensureInactiveTestSnapshot, ensureTestSnapshot } from "./test-helpers/snapshot.js";

const start = Date.now();
process.stdout.write("[warm] ensuring symphony-test-base...\n");
await ensureTestSnapshot();
process.stdout.write(`[warm] symphony-test-base ready (+${Date.now() - start}ms)\n`);

const inactiveStart = Date.now();
process.stdout.write("[warm] ensuring symphony-test-inactive...\n");
const inactiveName = await ensureInactiveTestSnapshot();
process.stdout.write(`[warm] ${inactiveName} ready (+${Date.now() - inactiveStart}ms)\n`);

process.stdout.write(`[warm] done in ${Date.now() - start}ms\n`);
