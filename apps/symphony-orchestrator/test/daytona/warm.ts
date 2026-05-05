// One-off warmer for the local Daytona test stack.
// Builds symphony-test-base + symphony-test-inactive so the first integration
// test run does not pay the snapshot-build cost. Idempotent — re-running on a
// warm stack is a fast metadata roundtrip.
//
// Usage: bun run test/daytona/warm.ts

import { ensureInactiveTestSnapshot, ensureTestSnapshot } from "./test-helpers/snapshot.js";

const start = Date.now();
console.log("[warm] ensuring symphony-test-base...");
await ensureTestSnapshot();
console.log(`[warm] symphony-test-base ready (+${Date.now() - start}ms)`);

const inactiveStart = Date.now();
console.log("[warm] ensuring symphony-test-inactive...");
const inactiveName = await ensureInactiveTestSnapshot();
console.log(`[warm] ${inactiveName} ready (+${Date.now() - inactiveStart}ms)`);

console.log(`[warm] done in ${Date.now() - start}ms`);
