// @vitest-environment node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { waitUntil } from "./helpers/wait-until.js";
import { ProcessGroupSupervisor, runSupervisedCommand } from '../scripts/process-group-supervisor.mjs';
import { executeTestPhase, measureTestRssKiB, processTreeRss } from '../scripts/test-phase-executor.mjs';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('joins an ignoring-TERM command and descendant inside the inherited deadline, retaining bounded output on deadline or abort', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-stage-timeout-'));
  temporaryRoots.push(root);
  for (const trigger of ['deadline', 'abort']) {
    const pidFile = path.join(root, `${trigger}.pid`);
    const childFile = path.join(root, `${trigger}.child`);
    const controller = new AbortController();
    const deadline = Date.now() + 1500;
    const completed = runSupervisedCommand(process.execPath, ['-e', `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.stdout.write('x'.repeat(512) + 'stdout-tail'); process.stderr.write('partial-stderr');
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`
        process.on('SIGTERM', () => {});
        require('node:fs').writeFileSync(${JSON.stringify(childFile)}, String(process.pid));
        setInterval(() => {}, 1000);
      `)}], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `], { timeout: 1000, deadline, graceMs: 100, capture: true, maxBuffer: 64, signal: controller.signal })
      .then(() => { throw new Error('Ignoring command unexpectedly succeeded'); }, error => error);
    if (trigger === 'abort') {
      await waitUntil(() => fs.existsSync(childFile), 'the owned descendant to start');
      controller.abort();
    }
    const failure = await completed;
    expect(failure).toMatchObject({ code: trigger === 'abort' ? 'ABORT_ERR' : 'STAGE_DEADLINE',
      aborted: trigger === 'abort', timedOut: trigger === 'deadline', processGroupSettled: true,
      stderr: 'partial-stderr', stdoutTruncated: true });
    expect(failure.stdout).toHaveLength(64);
    expect(failure.stdout.endsWith('stdout-tail')).toBe(true);
    expect(Date.now()).toBeLessThan(deadline);
    expect(isAlive(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(false);
    expect(isAlive(Number(fs.readFileSync(childFile, 'utf8')))).toBe(false);
  }
});

it.each(["signal", "watchdog"] as const)("terminates the launcher shard group through the outer %s path", async (trigger) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-process-group-"));
  temporaryRoots.push(root);
  const pidFile = path.join(root, "descendant.pid");
  const readyFile = path.join(root, "descendant.ready");
  const leaderTermFile = path.join(root, "leader-term");
  const runtimeFile = path.join(root, "runtime-root");
  const launcherUrl = new URL("../scripts/run-provisioned-tests.mjs", import.meta.url).href;
  const outer = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    import { runUnits } from ${JSON.stringify(launcherUrl)};
    await runUnits([{ label: "synthetic", args: [] }], {
      jobs: 1,
      graceMs: 200,
      onRun: () => {},
      spawnUnit: (_unit, env) => {
          fs.writeFileSync(${JSON.stringify(runtimeFile)}, env.MANDIBLE_TEST_RUNTIME_ROOT);
          return spawn(process.execPath, ["-e", ${JSON.stringify(`
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
        `)}], { detached: true, stdio: "ignore" });
        },
        measureRssKiB: () => ${JSON.stringify(trigger)} === "watchdog" && fs.existsSync(${JSON.stringify(readyFile)}) ? 2 : 0,
        rssLimitKiB: 1,
        monitorIntervalMs: 10,
      });
  `], { stdio: "ignore" });
  await waitUntil(() => fs.existsSync(readyFile), "the descendant to report ready");
  const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
  if (trigger === "signal") outer.kill("SIGTERM");
  await waitForExit(outer);
  await waitUntil(() => !isAlive(descendantPid), "the descendant process group to be cleaned up");
  expect(fs.existsSync(fs.readFileSync(runtimeFile, "utf8"))).toBe(false);
  expect(fs.existsSync(leaderTermFile)).toBe(true);
  expect(isAlive(descendantPid)).toBe(false);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  await waitUntil(() => child.exitCode !== null || child.signalCode !== null, `process ${child.pid} to exit`);
}

// Retain the exited group leader as a zombie under a controller outside that
// group. This makes XNU's otherwise transient EPERM state deterministic.
it.skipIf(process.platform !== "darwin")("confirms an owned zombie-only group has no running descendants", async () => {
  const controller = spawn("/usr/bin/perl", ["-MPOSIX", "-e", `
    $|=1; my $pid=fork(); die "fork" unless defined $pid;
    if (!$pid) { POSIX::setsid(); POSIX::_exit(0); }
    print "$pid\n"; <STDIN>; waitpid($pid,0);
  `], { stdio: ["pipe", "pipe", "inherit"] });
  const groupId = await new Promise<number>((resolve) => controller.stdout!.once("data", (data) => resolve(Number(data.toString().trim()))));
  const supervisor = new ProcessGroupSupervisor();
  try {
    await waitUntil(() => {
      try { process.kill(-groupId, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    }, "the zombie-only group to report EPERM");
    const exited = Object.assign(new EventEmitter(), { pid: groupId, exitCode: 0, signalCode: null });
    supervisor.attach(exited);
    // A mutated ChildProcess.pid must never change the captured group identity.
    exited.pid = process.pid;
    expect(await supervisor.settle(exited)).toEqual({ code: 0, signal: null });
  } finally {
    await supervisor.close();
    controller.stdin!.end("reap\n");
    await waitForExit(controller);
  }
});

it("refuses a live replacement leader after the owned child exits", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const supervisor = new ProcessGroupSupervisor();
  const exited = Object.assign(new EventEmitter(), { pid: child.pid, exitCode: 0, signalCode: null });
  try {
    supervisor.attach(exited);
    await expect(supervisor.settle(exited)).rejects.toThrow("could not be cleaned up");
    expect(isAlive(child.pid!)).toBe(true);
  } finally {
    await supervisor.close();
    child.kill("SIGKILL");
    await waitForExit(child);
  }
});

it("reports EPERM without positive zombie-only evidence", async () => {
  const supervisor = new ProcessGroupSupervisor();
  const exited = Object.assign(new EventEmitter(), { pid: 2147483647, exitCode: 0, signalCode: null });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("real permission boundary"), { code: "EPERM" }); });
  try {
    supervisor.attach(exited);
    const result = supervisor.settle(exited);
    await expect(result).rejects.toThrow("could not be cleaned up");
    if (process.platform === 'darwin') {
      await expect(result).rejects.toMatchObject({ errors: expect.arrayContaining([
        expect.objectContaining({ code: 'EPERM', processGroup: expect.objectContaining({
          groupId: 2147483647,
          child: expect.objectContaining({ capturedPid: 2147483647, exitCode: 0, signalCode: null }),
          inspection: { members: [] },
          probes: [{ signal: 0, outcome: 'EPERM' }, { signal: 0, outcome: 'EPERM' }],
        }) }),
      ]) });
    }
  } finally {
    kill.mockRestore();
    await supervisor.close();
  }
});

function privateRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-phase-cleanup-"));
  temporaryRoots.push(root);
  return {
    env: { ...process.env, MANDIBLE_TEST_RUNTIME_ROOT: root },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

it.each(process.platform === "darwin" ? [false, true] : [false])("settles sequential phases and reports normal and nonzero exits after transient permission probe=%s", async (transientPermission) => {
  const supervisor = new ProcessGroupSupervisor({ graceMs: 100 });
  const roots: string[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  let activeGroupId: number | undefined;
  let permissionInjected = false;
  const realKill = process.kill.bind(process);
  const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (transientPermission && !permissionInjected && signal === 0 && pid === -activeGroupId!) {
      permissionInjected = true;
      throw Object.assign(new Error('Transient owned-group probe'), { code: 'EPERM' });
    }
    return realKill(pid, signal);
  });
  const groupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-phase-descendant-"));
  temporaryRoots.push(groupRoot);
  const pidFile = path.join(groupRoot, "descendant.pid");
  const leaderScript = `
    const fs = require("node:fs");
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `)}], { stdio: "ignore" });
    const ready = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(pidFile)})) { clearInterval(ready); process.exit(0); }
    }, 10);
  `;
  try {
    for (const code of [0, 7]) {
      const outcome = await executeTestPhase({
        supervisor,
        createRuntime: privateRuntime,
        spawnChild: (env: NodeJS.ProcessEnv) => {
          roots.push(env.MANDIBLE_TEST_RUNTIME_ROOT!);
          if (code !== 0) expect(isAlive(Number(fs.readFileSync(pidFile, "utf8")))).toBe(false);
          const child = spawn(process.execPath, ["-e", code === 0 ? leaderScript : `process.exit(${code})`], { detached: true, env, stdio: "ignore" });
          children.push(child);
          activeGroupId = child.pid;
          return child;
        },
        monitorIntervalMs: 10,
      });
      expect(outcome.status).toBe(code === 0 ? "passed" : "failed");
      expect(outcome.result).toEqual({ code, signal: null });
      expect(fs.existsSync(roots.at(-1)!)).toBe(false);
      expect(isAlive(Number(fs.readFileSync(pidFile, "utf8")))).toBe(false);
    }
    expect(permissionInjected).toBe(transientPermission);
  } finally {
    probe.mockRestore();
    await supervisor.close();
    // A failing assertion must still reap these freshly captured owned groups.
    for (const child of children) {
      const cleanup = new ProcessGroupSupervisor({ graceMs: 100 });
      try { cleanup.attach(child); await cleanup.settle(child); }
      finally { await cleanup.close(); }
    }
  }
});

it.each(["throw", "missing-binary", "measurement"])("releases acquired resources after %s failure", async (failure) => {
  const supervisor = new ProcessGroupSupervisor({ graceMs: 100 });
  let runtimeRoot = "";
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const outcome = await executeTestPhase({
      supervisor,
      createRuntime: privateRuntime,
      spawnChild: (env: NodeJS.ProcessEnv) => {
        runtimeRoot = env.MANDIBLE_TEST_RUNTIME_ROOT!;
        if (failure === "throw") throw new Error("synchronous spawn failure");
        child = spawn(failure === "missing-binary" ? path.join(runtimeRoot, "absent-binary") : process.execPath,
          ["-e", "setInterval(() => {}, 1000)"], { detached: true, env, stdio: "ignore" });
        return child;
      },
      measureRssKiB: () => { throw new Error("ps sample unavailable"); },
      monitorIntervalMs: 10,
    });
    expect(outcome.status).toBe("error");
    expect(String(outcome.error)).toMatch(failure === "throw" ? /synchronous spawn failure/ : failure === "missing-binary" ? /ENOENT/ : /ps sample unavailable/);
    expect(fs.existsSync(runtimeRoot)).toBe(false);
    if (child?.pid) expect(isAlive(child.pid)).toBe(false);
    const next = await executeTestPhase({
      supervisor, createRuntime: privateRuntime,
      spawnChild: (env: NodeJS.ProcessEnv) => spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, env, stdio: "ignore" }),
    });
    expect(next.status).toBe("passed");
  } finally {
    await supervisor.close();
  }
});

it("counts parent RSS only when requested and reports failed ps samples", () => {
  const child = { pid: 123 };
  const measurement = { treeRssKiB: () => 80, parentRssKiB: () => 25 };
  expect(measureTestRssKiB(child, measurement)).toBe(80);
  expect(measureTestRssKiB(child, { ...measurement, includeParentRss: true })).toBe(105);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = "/mandible-phase-missing-path";
    expect(() => processTreeRss(process.pid)).toThrow("Cannot measure test process RSS");
  } finally {
    process.env.PATH = previousPath;
  }
});
