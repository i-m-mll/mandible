import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { getDaemonLogger } from "./daemon-log.js";
import { locateCodexRollout } from "./parsers/codex.js";

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_SUFFIX = ".lock";
const CACHE_MS = 1_000;

export type CodexTaskLiveness =
  | { status: "live"; pid: number }
  | { status: "not_live" }
  | { status: "unavailable"; reason: string };

type CodexTaskLockSnapshot =
  | { status: "current"; live: Map<string, number> }
  | { status: "unavailable"; reason: string };

type CachedSnapshot = { expiresAt: number; snapshot: CodexTaskLockSnapshot };

const cache = new Map<string, CachedSnapshot>();
/** The last reported failure per lock directory or rollout, so an outage logs once per change. */
const reportedFailures = new Map<string, string>();

/**
 * Log a liveness check that could not complete, loudly and once per distinct
 * failure: every holder behind it reads as `unknown` until it recovers.
 */
function reportUnavailable(key: string, reason: string): void {
  if (reportedFailures.get(key) === reason) return;
  reportedFailures.set(key, reason);
  getDaemonLogger()("error", "codex_task_liveness_unavailable", { target: key, reason });
}

function reportRecovered(key: string): void {
  if (!reportedFailures.delete(key)) return;
  getDaemonLogger()("info", "codex_task_liveness_recovered", { target: key });
}

function lsofPath(): string | null {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Parse lsof's field form without trusting display-width-truncated columns. */
export function parseCodexTaskLockLsof(output: string, lockDir: string): Map<string, number> {
  const live = new Map<string, number>();
  let pid: number | null = null;
  let command: string | null = null;
  const expectedDir = path.resolve(lockDir);

  for (const line of output.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      command = null;
      continue;
    }
    if (field === "c") {
      command = value.trim();
      continue;
    }
    if (field !== "n" || pid === null || command !== "codex") continue;

    const lockPath = path.resolve(value);
    if (path.dirname(lockPath) !== expectedDir) continue;
    const basename = path.basename(lockPath);
    if (!basename.endsWith(LOCK_SUFFIX)) continue;
    const threadId = basename.slice(0, -LOCK_SUFFIX.length);
    if (CODEX_THREAD_ID.test(threadId)) live.set(threadId, pid);
  }
  return live;
}

function scanCodexTaskLocks(lockDir: string): CodexTaskLockSnapshot {
  if (!fs.existsSync(lockDir)) {
    return { status: "unavailable", reason: "Codex thread-writer lock directory is missing" };
  }
  const executable = lsofPath();
  if (!executable) return { status: "unavailable", reason: "lsof is unavailable" };

  try {
    const output = execFileSync(executable, ["-Fpcn", "+D", lockDir], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: "current", live: parseCodexTaskLockLsof(output, lockDir) };
  } catch (error) {
    const record = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = typeof record.stdout === "string"
      ? record.stdout
      : Buffer.isBuffer(record.stdout) ? record.stdout.toString("utf8") : "";
    const stderr = typeof record.stderr === "string"
      ? record.stderr
      : Buffer.isBuffer(record.stderr) ? record.stderr.toString("utf8") : "";
    // lsof exits 1 when the directory is readable but no process has an open
    // descriptor in it. That is a complete, authoritative empty snapshot.
    if (record.status === 1 && !stderr.trim()) {
      return { status: "current", live: parseCodexTaskLockLsof(stdout, lockDir) };
    }
    return {
      status: "unavailable",
      reason: stderr.trim() || (error instanceof Error ? error.message : String(error)),
    };
  }
}

function currentSnapshot(lockDir: string): CodexTaskLockSnapshot {
  const now = Date.now();
  const cached = cache.get(lockDir);
  if (cached && cached.expiresAt > now) return cached.snapshot;
  const snapshot = scanCodexTaskLocks(lockDir);
  cache.set(lockDir, { expiresAt: now + CACHE_MS, snapshot });
  if (snapshot.status === "unavailable") reportUnavailable(lockDir, snapshot.reason);
  else reportRecovered(lockDir);
  return snapshot;
}

/**
 * Resolve task activity from Codex's own writer-lock ownership.
 *
 * The ingested rollout supplies the exact provider identity and Codex root;
 * Mandible stores no second mutable task-status row. A leftover lock filename
 * is not enough: the Codex process must still hold the descriptor open.
 */
export function readCodexTaskLiveness(sourcePath: string, threadId: string): CodexTaskLiveness {
  if (!CODEX_THREAD_ID.test(threadId)) return { status: "not_live" };
  const location = locateCodexRollout(sourcePath);
  if (!location) {
    const reason = "ingested source is outside a Codex rollout root";
    reportUnavailable(sourcePath, reason);
    return { status: "unavailable", reason };
  }
  const lockDir = path.join(location.codexRoot, "thread-writer-locks");
  const snapshot = currentSnapshot(lockDir);
  if (snapshot.status === "unavailable") return snapshot;
  const pid = snapshot.live.get(threadId);
  return pid ? { status: "live", pid } : { status: "not_live" };
}

export function clearCodexTaskLivenessCache(): void {
  cache.clear();
  reportedFailures.clear();
}
