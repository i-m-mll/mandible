import { spawnSync } from "node:child_process";
import { createTestRuntime } from "./test-runtime-isolation.mjs";

export function processTreeRss(rootPid) {
  const snapshot = spawnSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 1_000 });
  if (snapshot.error || snapshot.status !== 0) {
    throw new Error(`Cannot measure test process RSS: ${snapshot.stderr || snapshot.error?.message || snapshot.status}`);
  }
  const rows = snapshot.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error(`Invalid process RSS sample: ${line}`);
    return { pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]) };
  });
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const descendants = new Set([rootPid]);
  for (const pid of descendants) {
    for (const child of children.get(pid) ?? []) descendants.add(child);
  }
  return rows.reduce((total, row) => total + (descendants.has(row.pid) ? row.rss : 0), 0);
}

export function measureTestRssKiB(child, {
  includeParentRss = false,
  treeRssKiB = processTreeRss,
  parentRssKiB = () => Math.ceil(process.memoryUsage().rss / 1024),
} = {}) {
  return treeRssKiB(child.pid) + (includeParentRss ? parentRssKiB() : 0);
}

/** Settle the entire child group before releasing its private runtime or returning. */
export async function executeTestPhase({
  supervisor,
  spawnChild,
  includeParentRss = false,
  measureRssKiB = (child) => measureTestRssKiB(child, { includeParentRss }),
  rssLimitKiB = 950_000,
  monitorIntervalMs = 100,
  createRuntime = createTestRuntime,
}) {
  let runtime;
  let monitor;
  let stop;
  let measurementError;
  let peakKiB = 0;
  let memoryKilled = false;
  let result;
  let error;
  try {
    if (supervisor.interruptedSignal()) return { status: "interrupted", signal: supervisor.interruptedSignal(), peakKiB, memoryKilled };
    runtime = createRuntime();
    const child = spawnChild(runtime.env);
    if (!child.pid) {
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Test phase spawned without a process-group ID.")));
      });
    }
    supervisor.attach(child);
    monitor = setInterval(() => {
      if (stop) return;
      try {
        const totalKiB = measureRssKiB(child);
        if (!Number.isFinite(totalKiB) || totalKiB < 0) throw new Error(`Invalid test RSS measurement: ${totalKiB}`);
        peakKiB = Math.max(peakKiB, totalKiB);
        if (totalKiB < rssLimitKiB) return;
        memoryKilled = true;
      } catch (caught) {
        measurementError = caught;
      }
      clearInterval(monitor);
      // Capture rejection immediately; settle remains responsible for group cleanup.
      stop = supervisor.stopActive("SIGTERM").then(() => null, (caught) => caught);
    }, monitorIntervalMs);
    try {
      result = await supervisor.settle(child);
    } finally {
      clearInterval(monitor);
      const stopError = await stop;
      if (stopError) throw stopError;
    }
  } catch (caught) {
    error = caught;
  } finally {
    clearInterval(monitor);
    try { runtime?.close(); } catch (caught) {
      error = error ? new AggregateError([error, caught], "Test phase and runtime cleanup failed.") : caught;
    }
  }
  if (error || measurementError) return { status: "error", error: error ?? measurementError, peakKiB, memoryKilled };
  if (memoryKilled) return { status: "memory-limit", rssLimitKiB, peakKiB, memoryKilled };
  const signal = supervisor.interruptedSignal();
  if (signal) return { status: "interrupted", signal, peakKiB, memoryKilled };
  return { status: result.code === 0 ? "passed" : "failed", result, peakKiB, memoryKilled };
}

export function assertTestPhase(outcome, { phase, runner, rssDescription = "RSS" }) {
  switch (outcome.status) {
    case "passed": return;
    case "error": throw outcome.error;
    case "memory-limit": throw new Error(`${phase} exceeded ${outcome.rssLimitKiB} KiB ${rssDescription}.`);
    case "interrupted": throw new Error(`${runner} interrupted by ${outcome.signal}.`);
    case "failed": throw new Error(`${phase} failed (${outcome.result.signal ?? outcome.result.code}).`);
    default: throw new Error(`Unknown test phase outcome: ${outcome.status}`);
  }
}
