import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HealthResponse } from "./types.js";

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "mandible");
const DEFAULT_PID_FILE = path.join(DEFAULT_CACHE_DIR, "daemon.pid");

export function getPidFilePath(): string {
  return process.env.MANDIBLE_PID_FILE ?? DEFAULT_PID_FILE;
}

// Bug: 645f8a8 — lifecycle-owned daemon readiness. A process is "ready" only
// once it has completed the critical synchronous startup work (server
// listening, routes registered, DB open, pid written, session manager init,
// startup commit read). It deliberately does NOT wait on deferred background
// scans (issue scan) — those are not required for auth or
// dashboard mutations to be safe. The health endpoint reports this so the UI
// can distinguish "listener alive" from "ready for normal mutations".
//
// This is a per-process flag, matching the existing daemon singleton pattern
// (one daemon per process). It starts false; startDaemon flips it true once
// critical init finishes, and resets it false at the top of startDaemon so a
// re-entrant start in the same process re-arms the gate.
let daemonReady = false;
let daemonWarm = false;

export function isDaemonReady(): boolean {
  return daemonReady;
}

export function setDaemonReady(ready: boolean): void {
  daemonReady = ready;
}

/** Whether the daemon's first deferred startup reconciliation has completed. */
export function isDaemonWarm(): boolean {
  return daemonWarm;
}

export function setDaemonWarm(warm: boolean): void {
  daemonWarm = warm;
}

export function writePidFile(pid: number = process.pid, pidFilePath: string = getPidFilePath()): void {
  ensureDir(path.dirname(pidFilePath));
  fs.writeFileSync(pidFilePath, String(pid));
}

export function removePidFile(pidFilePath: string = getPidFilePath()): void {
  if (fs.existsSync(pidFilePath)) {
    fs.unlinkSync(pidFilePath);
  }
}

export function readPidFile(pidFilePath: string = getPidFilePath()): number | null {
  if (!fs.existsSync(pidFilePath)) {
    return null;
  }
  const raw = fs.readFileSync(pidFilePath, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) ? pid : null;
}

export async function checkHealth(port: number): Promise<HealthResponse | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/health",
        method: "GET",
        timeout: 500
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(data) as HealthResponse;
            resolve(parsed);
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

export async function waitForHealth(
  port: number,
  timeoutMs: number = 3000,
  intervalMs: number = 200
): Promise<HealthResponse | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await checkHealth(port);
    if (health) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export interface AutoStartResult {
  status: "already_running" | "started";
  pid?: number;
}

export interface AutoStartOptions {
  port: number;
  dbPath?: string;
  pidFilePath?: string;
  entryPath?: string;
}

export async function autoStartDaemon(options: AutoStartOptions): Promise<AutoStartResult> {
  const { port, dbPath, pidFilePath, entryPath } = options;
  const existing = await checkHealth(port);
  if (existing) {
    return { status: "already_running" };
  }

  const entry = entryPath ?? resolveEntryPath();
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    cwd: path.dirname(path.dirname(entry)),
    env: {
      ...process.env,
      MANDIBLE_PORT: String(port),
      ...(dbPath ? { MANDIBLE_DB: dbPath } : {}),
      ...(pidFilePath ? { MANDIBLE_PID_FILE: pidFilePath } : {})
    }
  });
  child.unref();

  await waitForHealth(port);
  return { status: "started", pid: child.pid ?? undefined };
}

export function stopDaemon(pidFilePath: string = getPidFilePath()): boolean {
  const pid = readPidFile(pidFilePath);
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function resolveEntryPath(): string {
  if (process.env.MANDIBLE_ENTRY) {
    return process.env.MANDIBLE_ENTRY;
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(currentDir, "..");
  const distEntry = path.join(rootDir, "dist", "index.js");
  if (fs.existsSync(distEntry)) {
    return distEntry;
  }
  throw new Error("dist/index.js not found; run the build first or set MANDIBLE_ENTRY");
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
