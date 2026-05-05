// Build and register the production-style `symphony-codex-bun` Daytona
// snapshot used by the orchestrator (referenced from `WORKFLOW.md`).
//
// Usage (from repo root):
//   DAYTONA_API_KEY=<key> \
//     bun run --filter @switchyard/symphony-orchestrator snapshot:build
//
// Idempotent: if a snapshot of the same name already exists in `active`
// state, exits cleanly. Otherwise creates from `./Dockerfile` and polls until
// active or build_failed (default 15min ceiling).
//
// Env (all optional except DAYTONA_API_KEY):
//   DAYTONA_API_KEY         required — local Daytona dashboard API key
//   DAYTONA_API_URL         default http://localhost:3000/api
//   DAYTONA_TARGET          default us
//   DAYTONA_SNAPSHOT        default symphony-codex-bun
//   DOCKERFILE              default ./Dockerfile (relative to this file)
//   SNAPSHOT_TIMEOUT_MS     default 900000 (15min)

import { fileURLToPath } from "node:url";

import { Daytona, DaytonaNotFoundError, Image } from "@daytona/sdk";

const apiKey = process.env.DAYTONA_API_KEY ?? "";
const apiUrl = process.env.DAYTONA_API_URL ?? "http://localhost:3000/api";
const target = process.env.DAYTONA_TARGET ?? "us";
const snapshotName = process.env.DAYTONA_SNAPSHOT ?? "symphony-codex-bun";
const dockerfilePath =
  process.env.DOCKERFILE ?? fileURLToPath(new URL("./Dockerfile", import.meta.url));
const timeoutMs = Number(process.env.SNAPSHOT_TIMEOUT_MS ?? 900_000);
const pollMs = 3_000;

if (!apiKey) {
  console.error("DAYTONA_API_KEY is required.");
  process.exit(1);
}

const daytona = new Daytona({
  apiKey,
  apiUrl,
  target,
  _experimental: { otelEnabled: false },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function poll(): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await daytona.snapshot.get(snapshotName);
    console.log(`[${new Date().toISOString()}] [${snapshotName}] state=${s.state}`);
    if (s.state === "active") {
      console.log(`[${snapshotName}] active.`);
      return;
    }
    if (s.state === "error" || s.state === "build_failed") {
      throw new Error(`Snapshot ${snapshotName} ${s.state}: ${s.errorReason ?? "unknown"}`);
    }
    if (s.state === "inactive") {
      await daytona.snapshot.activate(s);
    }
    await sleep(pollMs);
  }
  throw new Error(`Timeout waiting for snapshot ${snapshotName} to reach active.`);
}

async function maybeReplaceFailedExisting(): Promise<boolean> {
  try {
    const existing = await daytona.snapshot.get(snapshotName);
    console.log(`Snapshot ${snapshotName} exists (state=${existing.state}).`);
    if (existing.state === "active") {
      return true;
    }
    if (existing.state === "error" || existing.state === "build_failed") {
      console.log(`Existing snapshot is ${existing.state}; deleting before recreate.`);
      await daytona.snapshot.delete(existing);
      // Daytona's delete is async — wait for the record to disappear before
      // we retry create, otherwise we race a 409 Conflict on the stale name.
      const deleteDeadline = Date.now() + 60_000;
      while (Date.now() < deleteDeadline) {
        try {
          await daytona.snapshot.get(snapshotName);
        } catch (e) {
          if (e instanceof DaytonaNotFoundError) {
            return false;
          }
          throw e;
        }
        await sleep(pollMs);
      }
      throw new Error(`Snapshot ${snapshotName} did not finish deleting within 60s.`);
    }
    // Pending / building — wait it out instead of double-submitting.
    await poll();
    return true;
  } catch (e) {
    if (e instanceof DaytonaNotFoundError) {
      return false;
    }
    throw e;
  }
}

const alreadyDone = await maybeReplaceFailedExisting();
if (alreadyDone) {
  process.exit(0);
}

console.log(`Creating snapshot ${snapshotName} from ${dockerfilePath}...`);
await daytona.snapshot.create(
  {
    name: snapshotName,
    image: Image.fromDockerfile(dockerfilePath),
    resources: { cpu: 2, memory: 2, disk: 10 },
  },
  { timeout: Math.max(60, Math.floor(timeoutMs / 1000)) },
);

await poll();
