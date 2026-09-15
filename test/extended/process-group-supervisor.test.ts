// @vitest-environment node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("terminates the active detached shard group when its supervisor receives TERM", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-process-group-"));
  temporaryRoots.push(root);
  const pidFile = path.join(root, "descendant.pid");
  const leaderTermFile = path.join(root, "leader-term");
  const moduleUrl = new URL("../../scripts/process-group-supervisor.mjs", import.meta.url).href;
  const outer = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from "node:child_process";
    import { ProcessGroupSupervisor } from ${JSON.stringify(moduleUrl)};
    const supervisor = new ProcessGroupSupervisor({ graceMs: 200 });
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      process.on("SIGTERM", () => {
        fs.writeFileSync(${JSON.stringify(leaderTermFile)}, "received");
        process.exit(0);
      });
      const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
      setInterval(() => {}, 1000);
    `)}], { detached: true, stdio: "ignore" });
    supervisor.attach(child);
    await supervisor.settle(child);
    await supervisor.close();
  `], { stdio: "ignore" });
  await waitUntil(() => fs.existsSync(pidFile), 2_000);
  const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
  outer.kill("SIGTERM");
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
