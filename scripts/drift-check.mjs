#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const ignoredDocPrefixes = [".agents/skills/", ".claude/skills/", ".pi/skills/"];

const isIgnoredDoc = (path) => ignoredDocPrefixes.some((prefix) => path.startsWith(prefix));

const result = spawnSync("drift", ["check", "--format", "json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.status ?? 1);
}

const docs = Array.isArray(payload.docs) ? payload.docs : [];
const checkedDocs = docs.filter((doc) => !isIgnoredDoc(doc.path));
const ignoredDocs = docs.filter((doc) => isIgnoredDoc(doc.path));
const failedDocs = checkedDocs.filter((doc) => doc.result !== "fresh");

for (const doc of checkedDocs) {
  if (doc.result === "fresh") {
    console.log(`${doc.path}\n  ok`);
    continue;
  }

  console.log(`${doc.path}\n  ${doc.result}`);

  for (const anchor of doc.anchors ?? []) {
    if (anchor.result !== "fresh") {
      console.log(`  STALE  ${anchor.target ?? anchor.anchor ?? "anchor"}`);
    }
  }

  for (const link of doc.links ?? []) {
    if (link.result === "broken") {
      console.log(`  BROKEN  ${link.target} (${link.reason?.message ?? "broken link"})`);
    }
  }
}

if (ignoredDocs.length > 0) {
  console.log(`\nIgnored ${ignoredDocs.length} skill doc(s) for drift.`);
}

if (failedDocs.length > 0) {
  console.error(`\n${failedDocs.length} non-skill doc(s) failed drift.`);
  process.exit(1);
}
