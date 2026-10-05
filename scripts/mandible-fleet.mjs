#!/usr/bin/env bun
// Read-only inventory of running Mandible daemons and the files they hold open.
//
// This exists because there was no way to answer "what is running right now?"
// short of pgrep and lsof by hand. That is not a workflow anyone follows
// routinely, so nine orphaned preview daemons ran for up to two weeks — five of
// them executing code from deleted worktrees, all of them holding the live
// conversations index open read-write on one inode.
//
// The scan is the primary source, not the metadata: the daemons worth finding
// are exactly the ones no metadata file knows about any more. Nothing here
// signals, starts, or stops a process.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DAEMON_ENTRY_PATTERN = /(^|\/)dist\/index\.js(\s|$)/;
const LEGACY_PREVIEW_LABEL_PATTERN = /^bio\.mll\.mandible\.preview\./;
const PREVIEW_BASE_DIR = process.env.MANDIBLE_PREVIEW_BASE_DIR
  || path.join(os.homedir(), ".cache", "mandible", "previews");
const HEALTH_TIMEOUT_MS = 1_500;

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  await runCli();
}

async function runCli() {
  const json = process.argv.includes("--json");
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }
  const report = await collectFleet();
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printReport(report);
  if (report.sharedWritableFiles.length > 0 || report.supervisedPreviews.length > 0) {
    process.exitCode = 1;
  }
}

function printUsage() {
  console.log(`Usage: node scripts/mandible-fleet.mjs [--json]

List every running Mandible daemon and the databases and logs it holds open.

Read-only: nothing is started, stopped, or signalled.

Exits non-zero when it finds a fault worth acting on — two daemons writing the
same file, or a preview still registered with launchd.
`);
}

export async function collectFleet() {
  const daemons = [];
  for (const candidate of scanDaemonProcesses()) {
    daemons.push(await describeDaemon(candidate));
  }
  daemons.sort((left, right) => (left.port ?? 0) - (right.port ?? 0) || left.pid - right.pid);

  return {
    ok: true,
    scannedAt: new Date().toISOString(),
    daemons,
    sharedWritableFiles: findSharedWritableFiles(daemons),
    supervisedPreviews: listSupervisedPreviewJobs(),
    orphanedPreviewDirs: listOrphanedPreviewDirs(daemons),
  };
}

/** Every process whose command line runs a `dist/index.js` daemon entry point. */
function scanDaemonProcesses() {
  const listing = spawnSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  if (listing.status !== 0) return [];
  const candidates = [];
  for (const line of listing.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, rawPid, command] = match;
    if (!DAEMON_ENTRY_PATTERN.test(command)) continue;
    // The channel server also lives under dist/; it is not a daemon.
    if (command.includes("dist/channel-server/")) continue;
    candidates.push({ pid: Number(rawPid), command });
  }
  return candidates;
}

async function describeDaemon({ pid, command }) {
  const openFiles = listOpenFiles(pid);
  let port = null;
  let health = null;
  for (const candidate of listeningPorts(pid)) {
    const response = await readHealth(candidate);
    if (response) {
      port = candidate;
      health = response;
      break;
    }
    port ??= candidate;
  }
  const entry = extractDaemonEntry(command);

  return {
    pid,
    port,
    entry,
    cwd: openFiles.cwd,
    // A daemon whose entry point no longer resolves is running code from a
    // deleted worktree. That is the state five of the nine orphans were in.
    entryExists: entry ? fs.existsSync(entry) : null,
    role: health?.instance?.role ?? (health ? "live" : null),
    healthy: Boolean(health),
    startupCommit: health?.startup_commit?.hash ?? null,
    databases: dedupeFiles(openFiles.files.filter((file) => /\.db$/.test(file.path))),
    logs: dedupeFiles(openFiles.files.filter((file) => /\.log$/.test(file.path))),
    launchdLabels: launchdLabelsForPid(pid),
  };
}

/**
 * The daemon script path from a full command line.
 *
 * Cannot be a whitespace-delimited match: this repository lives under a path
 * containing spaces, which truncated the entry to a relative-looking fragment
 * and made a healthy daemon report itself as running from a deleted worktree.
 * argv[0] is found by taking the shortest prefix that names an existing file —
 * the interpreter always exists, even when the script it is running does not,
 * which is the case this has to keep reporting correctly.
 */
function extractDaemonEntry(command) {
  const marker = "/dist/index.js";
  const end = command.lastIndexOf(marker);
  if (end === -1) return null;
  const throughEntry = command.slice(0, end + marker.length);

  for (let space = throughEntry.indexOf(" "); space !== -1; space = throughEntry.indexOf(" ", space + 1)) {
    if (fs.existsSync(throughEntry.slice(0, space))) {
      return throughEntry.slice(space + 1);
    }
  }
  return throughEntry;
}

/**
 * Open regular files for one pid, with the inode and the access mode.
 *
 * The inode is the load-bearing column: two daemons pointed at different paths
 * are isolated, two daemons on the same inode are not, and only the inode can
 * tell those apart once symlinks and copies are involved.
 */
function listOpenFiles(pid) {
  const result = spawnSync("lsof", ["-p", String(pid), "-Fnaits"], { encoding: "utf8" });
  if (result.status !== 0 && !result.stdout) return { cwd: null, files: [] };

  const files = [];
  let cwd = null;
  let current = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "f") {
      current = { fd: value };
    } else if (tag === "a") {
      current.access = value.trim();
    } else if (tag === "t") {
      current.type = value;
    } else if (tag === "i") {
      current.inode = value;
    } else if (tag === "n") {
      if (current.fd === "cwd") cwd = value;
      if (current.type === "REG" && current.fd && /^\d+$/.test(current.fd)) {
        files.push({
          path: value,
          inode: current.inode ?? null,
          // lsof reports "u" for read/write, "r" read-only, "w" write-only.
          writable: current.access === "u" || current.access === "w",
        });
      }
      current = {};
    }
  }
  return { cwd, files };
}

/**
 * Every TCP port the process is listening on.
 *
 * A daemon holds more than one listening socket, so picking the first match
 * reported a port that nothing answered on and mislabelled a healthy daemon as
 * unreachable. The caller resolves the ambiguity by asking which one replies to
 * /api/health rather than by guessing.
 */
/** Collapse repeated descriptors on one file, keeping how many there are. */
function dedupeFiles(files) {
  const byKey = new Map();
  for (const file of files) {
    const key = `${file.inode}:${file.path}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.descriptors += 1;
      existing.writable ||= file.writable;
      continue;
    }
    byKey.set(key, { ...file, descriptors: 1 });
  }
  return [...byKey.values()];
}

function listeningPorts(pid) {
  // -a is required: lsof ORs its selection options, so -p with -i and no -a
  // lists every listening socket on the machine rather than this process's.
  // Without it this reported an unrelated process's port for the live daemon.
  const result = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], {
    encoding: "utf8",
  });
  const ports = new Set();
  for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
    const match = line.match(/^n.*:(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

/**
 * Files more than one daemon holds open for writing, keyed by inode.
 *
 * This is the exact signature of the defect that produced this tool: ten
 * daemons with fds on inode 224426418, the live conversations index.
 */
function findSharedWritableFiles(daemons) {
  const byInode = new Map();
  for (const daemon of daemons) {
    const seen = new Set();
    for (const file of [...daemon.databases, ...daemon.logs]) {
      if (!file.writable || !file.inode || seen.has(file.inode)) continue;
      seen.add(file.inode);
      if (!byInode.has(file.inode)) byInode.set(file.inode, { inode: file.inode, paths: new Set(), pids: [] });
      const record = byInode.get(file.inode);
      record.paths.add(file.path);
      record.pids.push(daemon.pid);
    }
  }
  return [...byInode.values()]
    .filter((record) => record.pids.length > 1)
    .map((record) => ({ inode: record.inode, paths: [...record.paths], pids: record.pids }));
}

/** Preview jobs still registered with launchd. There should never be any. */
function listSupervisedPreviewJobs() {
  if (process.platform !== "darwin") return [];
  const result = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 3 && LEGACY_PREVIEW_LABEL_PATTERN.test(columns[columns.length - 1]))
    .map((columns) => ({
      label: columns[columns.length - 1],
      pid: columns[0] === "-" ? null : Number(columns[0]),
      lastExitStatus: Number(columns[1]),
    }));
}

function launchdLabelsForPid(pid) {
  if (process.platform !== "darwin") return [];
  const result = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 3 && Number(columns[0]) === pid)
    .map((columns) => columns[columns.length - 1]);
}

/** Preview directories whose recorded daemon is gone: disk nobody is using. */
function listOrphanedPreviewDirs(daemons) {
  if (!fs.existsSync(PREVIEW_BASE_DIR)) return [];
  const livePorts = new Set(daemons.map((daemon) => daemon.port).filter(Boolean));
  const orphans = [];
  for (const dirent of fs.readdirSync(PREVIEW_BASE_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const metadataPath = path.join(PREVIEW_BASE_DIR, dirent.name, "metadata.json");
    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    } catch {
      continue;
    }
    if (metadata.port && livePorts.has(metadata.port)) continue;
    orphans.push({
      path: path.join(PREVIEW_BASE_DIR, dirent.name),
      branch: metadata.branch ?? null,
      port: metadata.port ?? null,
      worktree: metadata.worktree ?? null,
      worktreeExists: metadata.worktree ? fs.existsSync(metadata.worktree) : null,
    });
  }
  return orphans;
}

function readHealth(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/api/health", timeout: HEALTH_TIMEOUT_MS },
      (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            // Any JSON is not a Mandible daemon. An unrelated local server
            // answering /api/health with a JSON 404 was enough to be mistaken
            // for one, so require a field only this daemon serves.
            const isMandible = parsed?.status === "ok" || Boolean(parsed?.startup_commit);
            resolve(isMandible ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("error", () => resolve(null));
    request.on("timeout", () => { request.destroy(); resolve(null); });
  });
}

function printReport(report) {
  console.log(`Mandible daemons running: ${report.daemons.length}`);
  for (const daemon of report.daemons) {
    const role = daemon.role ?? "unreachable";
    console.log("");
    console.log(`  pid ${daemon.pid}  port ${daemon.port ?? "-"}  ${role}${daemon.healthy ? "" : "  (not answering /api/health)"}`);
    console.log(`    entry:  ${daemon.entry ?? "unknown"}${daemon.entryExists === false ? "   <- MISSING: running code from a deleted worktree" : ""}`);
    if (daemon.cwd) console.log(`    cwd:    ${daemon.cwd}`);
    if (daemon.launchdLabels.length > 0) console.log(`    launchd: ${daemon.launchdLabels.join(", ")}`);
    for (const file of daemon.databases) {
      const connections = file.descriptors > 1 ? `, ${file.descriptors} fds` : "";
      console.log(`    db:     ${file.path}  (inode ${file.inode}${file.writable ? ", writable" : ""}${connections})`);
    }
    for (const file of daemon.logs) {
      console.log(`    log:    ${file.path}  (inode ${file.inode})`);
    }
  }

  if (report.sharedWritableFiles.length > 0) {
    console.log("");
    console.log("SHARED WRITABLE FILES — more than one daemon is writing these:");
    for (const shared of report.sharedWritableFiles) {
      console.log(`  inode ${shared.inode}  pids ${shared.pids.join(", ")}`);
      for (const filePath of shared.paths) console.log(`    ${filePath}`);
    }
  }

  if (report.supervisedPreviews.length > 0) {
    console.log("");
    console.log("SUPERVISED PREVIEWS — previews must not be launchd jobs:");
    for (const job of report.supervisedPreviews) {
      console.log(`  ${job.label}  pid ${job.pid ?? "-"}  last exit ${job.lastExitStatus}`);
    }
    console.log("  Remove them with: bun run iab-preview-cleanup -- --apply");
  }

  if (report.orphanedPreviewDirs.length > 0) {
    console.log("");
    console.log("Preview directories with no running daemon:");
    for (const orphan of report.orphanedPreviewDirs) {
      console.log(`  ${orphan.path}${orphan.worktreeExists === false ? "   (worktree deleted)" : ""}`);
    }
  }
}
