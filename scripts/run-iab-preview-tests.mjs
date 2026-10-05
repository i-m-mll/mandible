#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createTestRuntime } from "./test-runtime-isolation.mjs";
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

function processTreeRss(rootPid) {
  const snapshot = spawnSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" });
  if (snapshot.status !== 0) throw new Error(`ps failed: ${snapshot.stderr}`);
  const rows = snapshot.stdout.trim().split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]) }] : [];
  });
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => descendants.has(row.pid)).reduce((total, row) => total + row.rss, 0);
}

function spawnVitestShard(shard, env) {
  return spawn(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.iab-preview.config.ts",
    ...shard.args,
  ], {
    cwd: root,
    detached: true,
    env: { ...env, NODE_OPTIONS: "--max-old-space-size=384" },
    stdio: "inherit",
  });
}

export async function runIabPreviewTests({
  supervisor,
  selectedShards = shards,
  spawnShard = spawnVitestShard,
  measureRssKiB = (child) => processTreeRss(child.pid) + Math.ceil(process.memoryUsage().rss / 1024),
  rssLimitKiB = 950_000,
  monitorIntervalMs = 100,
} = {}) {
  if (!supervisor) throw new Error("The IAB preview phase requires one caller-owned process-group supervisor.");
  for (const shard of selectedShards) {
    await runShard({ supervisor, shard, spawnShard, measureRssKiB, rssLimitKiB, monitorIntervalMs });
  }
}

async function runShard({ supervisor, shard, spawnShard, measureRssKiB, rssLimitKiB, monitorIntervalMs }) {
  const runtime = createTestRuntime();
  const child = spawnShard(shard, runtime.env);
  supervisor.attach(child);
  let peakKiB = 0;
  let memoryKilled = false;
  const monitor = setInterval(() => {
    if (!child.pid) return;
    const totalKiB = measureRssKiB(child);
    peakKiB = Math.max(peakKiB, totalKiB);
    if (totalKiB >= rssLimitKiB && !memoryKilled) {
      memoryKilled = true;
      void supervisor.stopActive("SIGTERM");
    }
  }, monitorIntervalMs);
  let result;
  try {
    result = await supervisor.settle(child);
  } finally {
    clearInterval(monitor);
    runtime.close();
  }
  process.stdout.write(`iab-preview shard ${shard.label} peak_rss_kib=${peakKiB} memory_killed=${memoryKilled}\n`);
  if (memoryKilled) throw new Error(`IAB preview shard ${shard.label} exceeded ${rssLimitKiB} KiB RSS.`);
  if (supervisor.interruptedSignal()) throw new Error(`IAB preview runner interrupted by ${supervisor.interruptedSignal()}.`);
  if (result.code !== 0) throw new Error(`IAB preview shard ${shard.label} failed (${result.signal ?? result.code}).`);
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
