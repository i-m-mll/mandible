#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { ProcessGroupSupervisor } from "./process-group-supervisor.mjs";
import { executeTestPhase, assertTestPhase } from "./test-phase-executor.mjs";
import { runIabPreviewTests } from "./run-iab-preview-tests.mjs";

const root = process.cwd();
const vitestCli = "node_modules/vitest/vitest.mjs";
const rawArgs = process.argv.slice(2);
const defaultOnly = rawArgs[0] === "--default";
const ordinaryOnly = rawArgs[0] === "--ordinary-only";
const ordinaryArgs = ordinaryOnly ? rawArgs.slice(1) : rawArgs;
const supervisor = new ProcessGroupSupervisor();

async function runPhase(label, script, args = []) {
  const outcome = await executeTestPhase({
    supervisor,
    spawnChild: (env) => spawn(process.execPath, ["--smol", path.join(root, script), ...args], {
      cwd: root, detached: true, env, stdio: "inherit",
    }),
  });
  process.stdout.write(`extended phase ${label} peak_rss_kib=${outcome.peakKiB} memory_killed=${outcome.memoryKilled}\n`);
  assertTestPhase(outcome, { phase: `Extended phase ${label}`, runner: "Extended runner", rssDescription: "aggregate RSS" });
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
