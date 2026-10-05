// @vitest-environment node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runSupervisedCommand } from '../../scripts/process-group-supervisor.mjs';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('bounds a stage whose process ignores graceful termination', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-stage-timeout-'));
  temporaryRoots.push(root);
  const pidFile = path.join(root, 'stage.pid');
  await expect(runSupervisedCommand(process.execPath, ['-e', `
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `], { timeout: 1000, graceMs: 100, stdio: 'ignore' })).rejects.toThrow('stage deadline');
  expect(isAlive(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(false);
}, 3000);

it.each(["signal", "watchdog"] as const)("terminates the launcher shard group through the outer %s path", async (trigger) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-process-group-"));
  temporaryRoots.push(root);
  const pidFile = path.join(root, "descendant.pid");
  const readyFile = path.join(root, "descendant.ready");
  const leaderTermFile = path.join(root, "leader-term");
  const supervisorUrl = new URL("../../scripts/process-group-supervisor.mjs", import.meta.url).href;
  const launcherUrl = new URL("../../scripts/run-iab-preview-tests.mjs", import.meta.url).href;
  const outer = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    import { ProcessGroupSupervisor } from ${JSON.stringify(supervisorUrl)};
    import { runIabPreviewTests } from ${JSON.stringify(launcherUrl)};
    const supervisor = new ProcessGroupSupervisor({ graceMs: 200 });
    try {
      await runIabPreviewTests({
        supervisor,
        selectedShards: [{ label: "synthetic", args: [] }],
        spawnShard: () => spawn(process.execPath, ["-e", ${JSON.stringify(`
          const { spawn } = require("node:child_process");
          const fs = require("node:fs");
          process.on("SIGTERM", () => {
            fs.writeFileSync(${JSON.stringify(leaderTermFile)}, "received");
            process.exit(0);
          });
          spawn(process.execPath, ["-e", ${JSON.stringify(`
            const fs = require("node:fs");
            process.on("SIGTERM", () => {});
            fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");
            setInterval(() => {}, 1000);
          `)}], { stdio: "ignore" });
          setInterval(() => {}, 1000);
        `)}], { detached: true, stdio: "ignore" }),
        measureRssKiB: () => ${JSON.stringify(trigger)} === "watchdog" && fs.existsSync(${JSON.stringify(readyFile)}) ? 2 : 0,
        rssLimitKiB: 1,
        monitorIntervalMs: 10,
      });
    } finally {
      await supervisor.close();
    }
  `], { stdio: "ignore" });
  await waitUntil(() => fs.existsSync(readyFile), 2_000);
  const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
  if (trigger === "signal") outer.kill("SIGTERM");
  await waitForExit(outer, 2_000);
  await waitUntil(() => !isAlive(descendantPid), 2_000);
  expect(fs.existsSync(leaderTermFile)).toBe(true);
  expect(isAlive(descendantPid)).toBe(false);
}, 6_000);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("bounded process cleanup probe timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("supervisor did not exit")), timeoutMs)),
  ]);
}
