#!/usr/bin/env bun
// Attributes CPU-profile samples to time windows, typically the stalls that
// scripts/daemon-stall-probe.mjs recorded. Bun's .cpuprofile stamps samples
// in wall-clock microseconds, so probe start times line up with them directly.
// Docs: docs/daemon-stall-profiling.md.
import fs from "node:fs";
import { parseArgs } from "node:util";

const USAGE = `Usage: bun scripts/cpuprofile-windows.mjs <profile.cpuprofile> [options]

Without windows, prints the profile's hottest functions. With windows, prints
for each one the functions and stacks that were on the CPU during it.

  --stalls <file>     Windows from daemon-stall-probe --json output (one object per line)
  --window <iso,ms>   A window starting at <iso> lasting <ms> (repeatable)
  --min-ms <n>        Skip windows shorter than this (default 0)
  --top <n>           Rows per table (default 12)`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    stalls: { type: "string" },
    window: { type: "string", multiple: true, default: [] },
    "min-ms": { type: "string", default: "0" },
    top: { type: "string", default: "12" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help || positionals.length !== 1) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 2);
}

const top = Number(opts.top);
const minMs = Number(opts["min-ms"]);
const profile = JSON.parse(fs.readFileSync(positionals[0], "utf8"));

const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

function label(node) {
  const { functionName, url, lineNumber } = node.callFrame;
  const name = functionName || "(anonymous)";
  if (!url) return name;
  const file = url.replace(/^file:\/\//, "").replace(/^.*?\/(src|ui|scripts|node_modules)\//, "$1/");
  return `${name} ${file}:${lineNumber + 1}`;
}

const stackCache = new Map();
function stack(id) {
  let cached = stackCache.get(id);
  if (cached) return cached;
  const frames = [];
  for (let at = id; at !== undefined; at = parent.get(at)) {
    const node = nodes.get(at);
    if (node.callFrame.functionName !== "(root)") frames.push(label(node));
  }
  cached = frames.reverse();
  stackCache.set(id, cached);
  return cached;
}

const times = new Float64Array(profile.samples.length);
let clock = profile.startTime;
for (let i = 0; i < profile.samples.length; i += 1) {
  clock += profile.timeDeltas[i];
  times[i] = clock / 1000;
}
const deltas = [...profile.timeDeltas.slice(1)].sort((a, b) => a - b);
const intervalMs = (deltas[Math.floor(deltas.length / 2)] ?? 1000) / 1000;

function attribute(fromMs, toMs) {
  const self = new Map();
  const inclusive = new Map();
  const stacks = new Map();
  let count = 0;
  for (let i = 0; i < times.length; i += 1) {
    if (times[i] < fromMs || times[i] > toMs) continue;
    count += 1;
    const frames = stack(profile.samples[i]);
    const leaf = frames.at(-1) ?? "(root)";
    self.set(leaf, (self.get(leaf) ?? 0) + 1);
    for (const frame of new Set(frames)) inclusive.set(frame, (inclusive.get(frame) ?? 0) + 1);
    const key = frames.join(" > ");
    stacks.set(key, (stacks.get(key) ?? 0) + 1);
  }
  return { count, self, inclusive, stacks };
}

function table(title, counts, total) {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  console.log(`  ${title}`);
  for (const [name, n] of rows) {
    console.log(`    ${String(Math.round((100 * n) / total)).padStart(3)}%  ${String(n).padStart(6)}  ${name}`);
  }
}

function printWindow(heading, fromMs, toMs) {
  const { count, self, inclusive, stacks } = attribute(fromMs, toMs);
  console.log(`${heading}: ${count} samples (~${Math.round(count * intervalMs)} ms on CPU)`);
  if (count === 0) return;
  table("inclusive", inclusive, count);
  table("self", self, count);
  const hottest = [...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log("  hottest stacks");
  for (const [key, n] of hottest) console.log(`    ${n} samples\n      ${key.split(" > ").join("\n      ")}`);
}

function windows() {
  const parsed = opts.window.map(spec => {
    const [start, ms] = spec.split(",");
    return { start, ms: Number(ms) };
  });
  if (opts.stalls) {
    for (const line of fs.readFileSync(opts.stalls, "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      const record = JSON.parse(line);
      if (!record.error) parsed.push({ start: record.start, ms: record.ms });
    }
  }
  return parsed.filter(window => window.ms >= minMs);
}

const profiledFrom = new Date(profile.startTime / 1000).toISOString();
const profiledTo = new Date(profile.endTime / 1000).toISOString();
console.log(`profile ${profiledFrom} .. ${profiledTo}, ${times.length} samples, median interval ${intervalMs.toFixed(2)} ms\n`);

const selected = windows();
if (selected.length === 0) {
  printWindow("whole profile", -Infinity, Infinity);
} else {
  for (const window of selected) {
    const from = Date.parse(window.start);
    printWindow(`${window.start} ${window.ms} ms`, from, from + window.ms);
    console.log("");
  }
}
