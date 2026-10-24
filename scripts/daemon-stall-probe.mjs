#!/usr/bin/env bun
// Times daemon event-loop stalls from the client side. `/api/health` is
// answered in about a millisecond, so any health request that takes longer
// than the threshold was queued behind a blocked event loop; its start time
// gives the stall's phase. Docs: docs/daemon-stall-profiling.md.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE = `Usage: bun scripts/daemon-stall-probe.mjs [options]

Requests /api/health over the daemon's Unix socket every --interval-ms and
prints every request slower than --threshold-ms with its start time.

  --socket <path>        Daemon socket (default: $MANDIBLE_SOCKET, else the production socket)
  --interval-ms <n>      Request cadence (default 20)
  --threshold-ms <n>     Report requests slower than this (default 150)
  --duration <s>         Stop after this many seconds (default: until SIGINT)
  --sample               Run macOS \`sample\` on the daemon while a request is past the threshold
  --pid <pid>            Daemon pid for --sample (default: the socket's listener, via lsof)
  --sample-seconds <n>   Length of each sample (default 1)
  --sample-max <n>       Most samples per run (default 20)
  --out <dir>            Directory for samples (default: a new temp directory)
  --json                 One JSON object per line instead of text

On exit it prints a summary to stderr: request count, stalls, and stalls
grouped by second of the minute, which separates periodic jobs by phase.`;

const { values: opts } = parseArgs({
  options: {
    socket: { type: "string" },
    "interval-ms": { type: "string", default: "20" },
    "threshold-ms": { type: "string", default: "150" },
    duration: { type: "string" },
    sample: { type: "boolean", default: false },
    pid: { type: "string" },
    "sample-seconds": { type: "string", default: "1" },
    "sample-max": { type: "string", default: "20" },
    out: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

function positive(name) {
  const value = Number(opts[name]);
  if (!Number.isFinite(value) || value <= 0) fail(`--${name} must be a positive number`);
  return value;
}

function fail(message) {
  console.error(`daemon-stall-probe: ${message}`);
  process.exit(2);
}

const socketPath = opts.socket
  ?? process.env.MANDIBLE_SOCKET
  ?? path.join(os.homedir(), ".cache", "mandible", "local-api", "production.sock");
const intervalMs = positive("interval-ms");
const thresholdMs = positive("threshold-ms");
const durationMs = opts.duration === undefined ? Infinity : positive("duration") * 1000;
const sampleSeconds = positive("sample-seconds");
const sampleMax = positive("sample-max");

if (!fs.existsSync(socketPath)) fail(`socket not found: ${socketPath}`);

function socketListenerPid() {
  const result = spawnSync("lsof", ["-t", socketPath], { encoding: "utf8", timeout: 10_000 });
  const pids = (result.stdout ?? "").split("\n").map(Number).filter(pid => pid > 0 && pid !== process.pid);
  if (pids.length !== 1) fail(`cannot identify the daemon listening on ${socketPath} (lsof found ${pids.length}); pass --pid`);
  return pids[0];
}

const daemonPid = opts.sample ? (opts.pid ? Number(opts.pid) : socketListenerPid()) : null;
function sampleDir() {
  if (!opts.out) return fs.mkdtempSync(path.join(os.tmpdir(), "stall-probe-"));
  fs.mkdirSync(opts.out, { recursive: true });
  return opts.out;
}

const outDir = opts.sample ? sampleDir() : null;

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

function healthRequest() {
  return new Promise(resolve => {
    const req = http.request(
      { socketPath, path: "/api/health", method: "GET", agent, headers: { host: "localhost" } },
      res => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode === 200 ? null : `HTTP ${res.statusCode}`));
      },
    );
    req.on("error", error => resolve(error.message));
    req.end();
  });
}

let samplesTaken = 0;
let sampleRunning = false;

function startSample(stallStart) {
  if (sampleRunning || samplesTaken >= sampleMax) return null;
  samplesTaken += 1;
  sampleRunning = true;
  const file = path.join(outDir, `stall-${samplesTaken}-${stallStart.toISOString().replace(/[:.]/g, "")}.txt`);
  const child = spawn("sample", [String(daemonPid), String(sampleSeconds), "1", "-mayDie", "-file", file], {
    stdio: "ignore",
  });
  child.on("exit", () => { sampleRunning = false; });
  child.on("error", error => {
    sampleRunning = false;
    console.error(`daemon-stall-probe: sample failed: ${error.message}`);
  });
  return file;
}

function report(record) {
  if (opts.json) {
    console.log(JSON.stringify(record));
    return;
  }
  const detail = record.error ? `${record.ms} ms  error: ${record.error}` : `${record.ms} ms`;
  console.log(`${record.start}  ${detail}${record.sample ? `  sample=${record.sample}` : ""}`);
}

const stalls = [];
let requests = 0;
let stopping = false;
const startedAt = Date.now();

function summarize() {
  const bySecond = new Map();
  for (const stall of stalls) {
    const second = new Date(stall.start).getUTCSeconds();
    const bucket = bySecond.get(second) ?? { count: 0, maxMs: 0 };
    bucket.count += 1;
    bucket.maxMs = Math.max(bucket.maxMs, stall.ms);
    bySecond.set(second, bucket);
  }
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
  const worst = stalls.reduce((max, stall) => Math.max(max, stall.ms), 0);
  const lines = [
    `${requests} requests in ${elapsedS} s; ${stalls.length} over ${thresholdMs} ms; worst ${worst} ms`,
    ...[...bySecond.entries()]
      .sort(([a], [b]) => a - b)
      .map(([second, { count, maxMs }]) => `  :${String(second).padStart(2, "0")}  ${count} stalls, max ${maxMs} ms`),
  ];
  if (outDir) lines.push(`samples: ${outDir}`);
  console.error(lines.join("\n"));
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

while (!stopping && Date.now() - startedAt < durationMs) {
  const start = new Date();
  const t0 = performance.now();
  let sample = null;
  const trigger = opts.sample ? setTimeout(() => { sample = startSample(start); }, thresholdMs) : null;
  const error = await healthRequest();
  const ms = Math.round(performance.now() - t0);
  if (trigger) clearTimeout(trigger);
  requests += 1;
  if (error) {
    report({ start: start.toISOString(), ms, error });
  } else if (ms > thresholdMs) {
    const record = { start: start.toISOString(), ms, ...(sample ? { sample } : {}) };
    stalls.push(record);
    report(record);
  }
  await sleep(Math.max(0, intervalMs - (performance.now() - t0)));
}

agent.destroy();
summarize();
