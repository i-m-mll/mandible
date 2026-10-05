#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { ProcessGroupSupervisor } from "./process-group-supervisor.mjs";
import { createTestRuntime } from "./test-runtime-isolation.mjs";
import { runIabPreviewTests } from "./run-iab-preview-tests.mjs";

const root = process.cwd();
const vitestCli = "node_modules/vitest/vitest.mjs";
const rssLimitKiB = 950_000;
const rawArgs = process.argv.slice(2);
const defaultOnly = rawArgs[0] === "--default";
const ordinaryOnly = rawArgs[0] === "--ordinary-only";
const ordinaryArgs = ordinaryOnly ? rawArgs.slice(1) : rawArgs;
const supervisor = new ProcessGroupSupervisor();

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

async function runPhase(label, script, args = []) {
  const runtime = createTestRuntime();
  const child = spawn(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    detached: true,
    env: {
      ...runtime.env,
      NODE_OPTIONS: "--max-old-space-size=512",
    },
    stdio: "inherit",
  });
  supervisor.attach(child);
  let peakKiB = 0;
  let memoryKilled = false;
  const monitor = setInterval(() => {
    if (!child.pid) return;
    const totalKiB = processTreeRss(child.pid);
    peakKiB = Math.max(peakKiB, totalKiB);
    if (totalKiB >= rssLimitKiB && !memoryKilled) {
      memoryKilled = true;
      void supervisor.stopActive("SIGTERM");
    }
  }, 100);
  let result;
  try {
    result = await supervisor.settle(child);
  } finally {
    clearInterval(monitor);
    runtime.close();
  }
  process.stdout.write(`extended phase ${label} peak_rss_kib=${peakKiB} memory_killed=${memoryKilled}\n`);
  if (memoryKilled) throw new Error(`Extended phase ${label} exceeded ${rssLimitKiB} KiB aggregate RSS.`);
  if (supervisor.interruptedSignal()) throw new Error(`Extended runner interrupted by ${supervisor.interruptedSignal()}.`);
  if (result.code !== 0) throw new Error(`Extended phase ${label} failed (${result.signal ?? result.code}).`);
}

try {
  if (defaultOnly) {
    await runPhase("default", vitestCli, [
      "run", "--config", "vitest.config.ts", "--maxWorkers=1", "--fileParallelism=false",
    ]);
  } else {
    const vitestArgs = ["run", "--config", "vitest.extended.config.ts", "--maxWorkers=1", "--fileParallelism=false"];
    if (ordinaryArgs.length > 0) {
      await runPhase("ordinary-subset", vitestCli, [...vitestArgs, ...ordinaryArgs]);
    } else {
      const excluded = new Set([
        "test/extended/iab-preview-launcher.test.ts",
      ]);
      if (process.platform !== "darwin") excluded.add("test/extended/local-ca-lockf.test.ts");
      const files = readdirSync(path.join(root, "test", "extended"))
        .filter((name) => /\.test\.tsx?$/.test(name))
        .map((name) => `test/extended/${name}`)
        .filter((file) => !excluded.has(file))
        .sort();
      const batchSize = 1;
      const batchCount = Math.ceil(files.length / batchSize);
      for (let index = 0; index < files.length; index += batchSize) {
        const batch = files.slice(index, index + batchSize);
        await runPhase(`ordinary-${Math.floor(index / batchSize) + 1}-of-${batchCount}`, vitestCli, [
          ...vitestArgs,
          ...batch,
        ]);
      }
    }
    if (!ordinaryOnly) await runIabPreviewTests({ supervisor });
  }
} finally {
  await supervisor.close();
}
