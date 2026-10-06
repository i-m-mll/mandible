#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { executeTestPhase, assertTestPhase } from "./test-phase-executor.mjs";
import { ProcessGroupSupervisor } from "./process-group-supervisor.mjs";

const root = process.cwd();
const relativeTest = "test/extended/iab-preview-launcher.test.ts";
const testPath = path.join(root, relativeTest);
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const lines = fs.readFileSync(testPath, "utf8")
  .split("\n")
  .flatMap((line, index) => /^\s+it\(/.test(line) ? [index + 1] : []);
const shards = [
  ...lines.map((line) => ({ label: `line=${line}`, args: [`${relativeTest}:${line}`] })),
  { label: "demo-seed-drift-matrix", args: [relativeTest, "-t", "refuses .* before demo seed side effects"] },
];

if (lines.length === 0) throw new Error(`No test declarations found in ${relativeTest}.`);

function spawnVitestShard(shard, env) {
  return spawn(process.execPath, [
    "--smol", vitest,
    "run",
    "--config", "vitest.iab-preview.config.ts",
    ...shard.args,
  ], {
    cwd: root,
    detached: true,
    env,
    stdio: "inherit",
  });
}

export async function runIabPreviewTests({
  supervisor,
  selectedShards = shards,
  spawnShard = spawnVitestShard,
  measureRssKiB,
  rssLimitKiB = 950_000,
  monitorIntervalMs = 100,
} = {}) {
  if (!supervisor) throw new Error("The IAB preview phase requires one caller-owned process-group supervisor.");
  for (const shard of selectedShards) {
    await runShard({ supervisor, shard, spawnShard, measureRssKiB, rssLimitKiB, monitorIntervalMs });
  }
}

async function runShard({ supervisor, shard, spawnShard, measureRssKiB, rssLimitKiB, monitorIntervalMs }) {
  const outcome = await executeTestPhase({
    supervisor,
    spawnChild: (env) => spawnShard(shard, env),
    includeParentRss: true,
    measureRssKiB,
    rssLimitKiB,
    monitorIntervalMs,
  });
  process.stdout.write(`iab-preview shard ${shard.label} peak_rss_kib=${outcome.peakKiB} memory_killed=${outcome.memoryKilled}\n`);
  assertTestPhase(outcome, { phase: `IAB preview shard ${shard.label}`, runner: "IAB preview runner" });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const supervisor = new ProcessGroupSupervisor();
  try {
    await runIabPreviewTests({ supervisor });
  } finally {
    await supervisor.close();
  }
}
