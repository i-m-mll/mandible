#!/usr/bin/env bun
/**
 * `bun run test:provisioned [file...]`: the suite that needs a real browser,
 * macOS `lockf` and launchd, or a daemon fleet (test/README.md).
 *
 * Each unit runs in its own supervised Vitest process tree under a per-unit
 * RSS cap, a pool of units at a time, with output buffered per unit so
 * parallel units never interleave. The IAB launcher file is too large for one
 * process, so each of its declarations is its own unit.
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProcessGroupSupervisor } from "./process-group-supervisor.mjs";
import { executeTestPhase, sharedProcessTreeRss } from "./test-phase-executor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_DIR = "test/provisioned";
const LAUNCHER = `${SUITE_DIR}/iab-preview-launcher.test.ts`;
const NATIVE_REPLACEMENT = `${SUITE_DIR}/accepted-app-install.test.ts`;
const RSS_LIMIT_KIB = 950_000;
const RSS_SAMPLE_MS = 500;
const UNMEASURED_GRACE_MS = 60_000;

/**
 * Exclusive resources a file declares with an `// @provisioned <resource>`
 * header line. Units holding the same resource run one at a time.
 */
const RESOURCES = {
  // Headless Chrome process trees reach about 2 GB, and concurrent launches
  // contend for startup until geometry checks become load tests.
  chromium: { rssLimitKiB: 4_000_000 },
  // Fixture launchd jobs share the operator's GUI domain, and the full handoff
  // builds the deployed revision inside its own tree.
  launchd: { rssLimitKiB: 4_000_000 },
};

function declaredResource(file) {
  const declared = /^\/\/ @provisioned (\S+)$/m.exec(readFileSync(path.join(root, file), "utf8"))?.[1];
  if (declared && !(declared in RESOURCES)) {
    throw new Error(`${file} declares unknown provisioned resource ${declared}; known: ${Object.keys(RESOURCES).join(", ")}`);
  }
  return declared ?? null;
}

/** macOS lockf, launchd and native descriptor inspection. */
const DARWIN_ONLY = new Set(["local-ca-lockf.test.ts", "runtime-handoff-launchd.test.ts", "service-definition-reconciliation.test.ts", "runtime-handoff-full.test.ts", "sqlite-close-lifetime.test.ts", "accepted-app-install.test.ts"]);

function suiteFiles() {
  return readdirSync(path.join(root, SUITE_DIR))
    .filter((name) => /\.test\.tsx?$/.test(name))
    .map((name) => `${SUITE_DIR}/${name}`)
    .filter((file) => process.platform === "darwin" || !DARWIN_ONLY.has(path.basename(file)))
    .sort();
}

function launcherUnits() {
  const lines = readFileSync(path.join(root, LAUNCHER), "utf8")
    .split("\n")
    .flatMap((line, index) => /^\s+it\(/.test(line) ? [index + 1] : []);
  if (lines.length === 0) throw new Error(`No test declarations found in ${LAUNCHER}.`);
  return [
    ...lines.map((line) => ({ label: `${LAUNCHER}:${line}`, args: [`${LAUNCHER}:${line}`] })),
    { label: `${LAUNCHER} demo-seed drift matrix`, args: [LAUNCHER, "-t", "refuses .* before demo seed side effects"] },
  ];
}

export function provisionedUnits(files = suiteFiles()) {
  return files.flatMap((file) => path.normalize(file) === LAUNCHER
    ? launcherUnits()
    : [{ label: file, args: [file], resource: declaredResource(file) }]);
}

/** Memory the OS can hand out without swapping; macOS `freemem` omits reclaimable pages. */
function availableMemoryBytes() {
  if (process.platform === "darwin") {
    const stat = spawnSync("vm_stat", { encoding: "utf8" });
    if (stat.status !== 0) throw new Error(`vm_stat failed: ${stat.stderr}`);
    const pageSize = Number(/page size of (\d+) bytes/.exec(stat.stdout)?.[1]);
    const pages = (label) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(stat.stdout)?.[1] ?? 0);
    return pageSize * (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable"));
  }
  if (process.platform === "linux") {
    const kib = Number(/MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]);
    if (Number.isFinite(kib)) return kib * 1024;
  }
  return os.freemem();
}

/** Every slot may reach the per-unit RSS cap at once, so keep a quarter spare. */
function poolSize() {
  const override = Number(process.env.MANDIBLE_PROVISIONED_JOBS);
  if (Number.isInteger(override) && override > 0) return override;
  const byMemory = Math.floor((availableMemoryBytes() * 0.75) / (RSS_LIMIT_KIB * 1024));
  return Math.max(1, Math.min(os.availableParallelism(), byMemory));
}

function spawnVitest(unit, env) {
  return spawn(env.MANDIBLE_RUNTIME, [
    "--smol", path.join(root, "scripts", "run-vitest.js"), "run", ...unit.args,
  ], {
    cwd: root,
    detached: true,
    env: { ...env, MANDIBLE_TEST_SUITE: "provisioned" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function problem({ label, outcome }) {
  switch (outcome.status) {
    case "passed": return null;
    case "failed": return `${label} failed (${outcome.result.signal ?? outcome.result.code})`;
    case "memory-limit": return `${label} exceeded the ${outcome.rssLimitKiB} KiB process-tree RSS limit`;
    case "interrupted": return `${label} interrupted by ${outcome.signal}`;
    case "error": return `${label} could not run: ${outcome.error?.stack ?? outcome.error}`;
    default: return `${label} ended with unknown outcome ${outcome.status}`;
  }
}

function report(run) {
  const failure = problem(run);
  const line = `${failure ? "FAIL" : "pass"} ${run.label} ${run.seconds.toFixed(1)}s peak_rss_kib=${run.outcome.peakKiB}`;
  process.stdout.write(failure ? `\n===== ${line}\n${run.output}===== ${failure}\n\n` : `${line}\n`);
  // Preserve source identity and phase-cost evidence for the qualifying native
  // proof on success too; the ordinary concise suite report remains unchanged.
  if (!failure && path.normalize(run.label) === NATIVE_REPLACEMENT) process.stdout.write(run.output);
}

function sharedRssMeasure() {
  const treeRssKiB = sharedProcessTreeRss({ maxAgeMs: RSS_SAMPLE_MS });
  return (child) => treeRssKiB(child.pid);
}

/** Run units a pool at a time; each pool slot owns one process-group supervisor. */
export async function runUnits(units, {
  jobs = Math.min(poolSize(), units.length),
  spawnUnit = spawnVitest,
  rssLimitKiB = RSS_LIMIT_KIB,
  measureRssKiB = sharedRssMeasure(),
  monitorIntervalMs = RSS_SAMPLE_MS,
  graceMs,
  onRun = report,
} = {}) {
  process.setMaxListeners(Math.max(process.getMaxListeners(), jobs * 2 + 10));
  const queue = [...units];
  const held = new Set();
  const released = [];
  const runs = [];
  const supervisors = Array.from({ length: jobs }, () => new ProcessGroupSupervisor({ graceMs }));
  const interrupted = () => supervisors.find((supervisor) => supervisor.interruptedSignal())?.interruptedSignal();
  async function next() {
    for (;;) {
      if (queue.length === 0 || interrupted()) return null;
      const index = queue.findIndex((unit) => !unit.resource || !held.has(unit.resource));
      if (index >= 0) return queue.splice(index, 1)[0];
      await new Promise((resolve) => released.push(resolve));
    }
  }
  try {
    await Promise.all(supervisors.map(async (supervisor) => {
      for (let unit = await next(); unit; unit = await next()) {
        if (unit.resource) held.add(unit.resource);
        const output = [];
        const started = performance.now();
        const commandStartedAt = unit.nativeProofStartedAt ?? Date.now();
        const until = path.normalize(unit.args[0] ?? '') === NATIVE_REPLACEMENT ? commandStartedAt + 20_000 : null;
        let deadlineTimer;
        let deadlineStop;
        let deadlineReached = false;
        if (until) deadlineTimer = setTimeout(() => {
          deadlineReached = true;
          deadlineStop = supervisor.stopActive('SIGTERM').then(() => null, error => error);
        }, Math.max(0, until - Date.now()));
        let outcome;
        try { outcome = await executeTestPhase({
          supervisor,
          rssLimitKiB: unit.resource ? RESOURCES[unit.resource].rssLimitKiB : rssLimitKiB,
          measureRssKiB,
          monitorIntervalMs,
          unmeasuredGraceMs: UNMEASURED_GRACE_MS,
          spawnChild: (env) => {
            if (until && Date.now() >= until) throw new Error('Native replacement command deadline exceeded during runner preparation.');
            const child = spawnUnit(unit, { ...env, ...(until ? {
              MANDIBLE_NATIVE_PROOF_STARTED_AT: String(commandStartedAt), MANDIBLE_NATIVE_PROOF_UNTIL: String(until),
            } : {}) });
            child.stdout?.on("data", (chunk) => output.push(chunk));
            child.stderr?.on("data", (chunk) => output.push(chunk));
            return child;
          },
        }); } finally { clearTimeout(deadlineTimer); }
        const stopError = await deadlineStop;
        if (until && (deadlineReached || Date.now() >= until || stopError)) {
          outcome = { ...outcome, status: 'error', error: stopError || new Error('Native replacement command exceeded its original 20000ms deadline, including runner startup and cleanup.') };
        }
        if (unit.resource) {
          held.delete(unit.resource);
          for (const wake of released.splice(0)) wake();
        }
        const run = { label: unit.label, outcome, output: Buffer.concat(output).toString("utf8"),
          seconds: until ? (Date.now() - commandStartedAt) / 1000 : (performance.now() - started) / 1000 };
        runs.push(run);
        onRun(run);
      }
      for (const wake of released.splice(0)) wake();
    }));
  } finally {
    await Promise.all(supervisors.map((supervisor) => supervisor.close()));
  }
  return { runs, interrupted: interrupted() ?? null };
}

async function main(args) {
  const commandStartedAt = Date.now();
  const units = provisionedUnits(args.length > 0 ? args : undefined);
  if (units.length === 1 && path.normalize(units[0].args[0] ?? '') === NATIVE_REPLACEMENT) units[0].nativeProofStartedAt = commandStartedAt;
  const jobs = Math.min(poolSize(), units.length);
  process.stdout.write(`provisioned: ${units.length} units, ${jobs} at a time\n`);
  const started = performance.now();
  const { runs, interrupted } = await runUnits(units, { jobs });
  const wall = (performance.now() - started) / 1000;
  const slowest = [...runs].sort((a, b) => b.seconds - a.seconds).slice(0, 10);
  process.stdout.write(`\nwall ${wall.toFixed(1)}s; slowest units:\n${slowest.map((run) => `  ${run.seconds.toFixed(1)}s ${run.label}`).join("\n")}\n`);
  if (interrupted) {
    process.stderr.write(`provisioned: interrupted by ${interrupted}\n`);
    return;
  }
  const failures = runs.map(problem).filter(Boolean);
  if (failures.length > 0) {
    process.stderr.write(`provisioned: ${failures.length} of ${units.length} units failed:\n  ${failures.join("\n  ")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`provisioned: all ${units.length} units passed\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main(process.argv.slice(2));
