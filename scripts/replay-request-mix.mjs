#!/usr/bin/env bun
// Replays the GET requests a daemon logged (`http_request` lines in its
// stderr log) against another daemon's socket, at their original relative
// times. Used to load a preview with production's request mix while it is
// profiled. Docs: docs/daemon-stall-profiling.md.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE = `Usage: bun scripts/replay-request-mix.mjs --socket <path> [options]

  --socket <path>   Target daemon socket (required; never the production socket)
  --log <file>      Source log (default ~/.cache/mandible/production-stderr.log)
  --from <iso>      First request time to replay (default: 10 minutes before the log's last request)
  --to <iso>        Last request time to replay (default: the log's last request)
  --exclude <re>    Also skip pathnames matching this regular expression (repeatable)
  --concurrency <n> Most requests in flight (default 6, one browser's connection limit)
  --loop            Repeat the window until interrupted

Only GET requests are replayed. /api/health (mostly probes), the front door's
forward-auth checks and the /api/events stream are skipped. The log records
pathnames without query strings, so routes that need query parameters are
replayed without them. When the target is slower than the source, requests
queue behind the concurrency limit and the replay falls behind schedule; the
exit report says by how much.`;

const { values: opts } = parseArgs({
  options: {
    socket: { type: "string" },
    log: { type: "string", default: path.join(os.homedir(), ".cache", "mandible", "production-stderr.log") },
    from: { type: "string" },
    to: { type: "string" },
    exclude: { type: "string", multiple: true, default: [] },
    concurrency: { type: "string", default: "6" },
    loop: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function fail(message) {
  console.error(`replay-request-mix: ${message}`);
  process.exit(2);
}

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!opts.socket) fail("--socket is required");
if (path.basename(opts.socket) === "production.sock") fail("refusing to replay against the production socket");

const DEFAULT_EXCLUDES = ["^/api/health$", "^/api/client-auth/forward-auth$", "^/api/events$"];
const exclude = [...DEFAULT_EXCLUDES, ...opts.exclude].map(pattern => new RegExp(pattern));
const concurrency = Number(opts.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) fail("--concurrency must be a positive integer");
const logged = [];
for (const line of fs.readFileSync(opts.log, "utf8").split("\n")) {
  if (!line.includes('"http_request"')) continue;
  const record = JSON.parse(line);
  if (record.method !== "GET" || exclude.some(re => re.test(record.pathname))) continue;
  logged.push({ at: Date.parse(record.time), pathname: record.pathname });
}
if (logged.length === 0) fail(`no GET http_request lines in ${opts.log}`);

const last = logged.at(-1).at;
const from = opts.from ? Date.parse(opts.from) : last - 10 * 60_000;
const to = opts.to ? Date.parse(opts.to) : last;
const requests = logged.filter(request => request.at >= from && request.at <= to);
if (requests.length === 0) fail("no requests in the selected window");

const counts = new Map();
for (const { pathname } of requests) {
  const route = pathname.replace(/\/[0-9a-f-]{7,}(?=\/|$)/gi, "/:id");
  counts.set(route, (counts.get(route) ?? 0) + 1);
}
console.error(`replaying ${requests.length} GETs over ${Math.round((to - from) / 1000)} s; top routes:`);
for (const [route, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.error(`  ${String(n).padStart(6)}  ${route}`);
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

const failures = new Map();
const REQUEST_TIMEOUT_MS = 60_000;

function get(pathname) {
  return new Promise(resolve => {
    const req = http.request(
      { socketPath: opts.socket, path: pathname, method: "GET", headers: { host: "localhost" }, timeout: REQUEST_TIMEOUT_MS },
      res => {
        if (res.statusCode >= 500) failures.set(pathname, res.statusCode);
        res.resume();
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no response in ${REQUEST_TIMEOUT_MS} ms`)));
    req.on("error", error => failures.set(pathname, error.message));
    req.on("close", resolve);
    req.end();
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

let inFlight = 0;
let slotFreed = () => {};
let maxLagMs = 0;
let replayed = 0;

async function acquire() {
  while (inFlight >= concurrency) await new Promise(resolve => { slotFreed = resolve; });
  inFlight += 1;
}

function release() {
  inFlight -= 1;
  slotFreed();
}

do {
  const startedAt = performance.now();
  const pending = [];
  for (const request of requests) {
    if (stopping) break;
    await sleep(request.at - from - (performance.now() - startedAt));
    await acquire();
    maxLagMs = Math.max(maxLagMs, performance.now() - startedAt - (request.at - from));
    replayed += 1;
    pending.push(get(request.pathname).finally(release));
  }
  await Promise.all(pending);
} while (opts.loop && !stopping);

console.error(`replayed ${replayed} requests; worst lag behind schedule ${Math.round(maxLagMs)} ms`);
if (failures.size > 0) {
  console.error(`${failures.size} pathnames failed:`);
  for (const [pathname, reason] of failures) console.error(`  ${reason}  ${pathname}`);
}
