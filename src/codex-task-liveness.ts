import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { getDaemonLogger } from "./daemon-log.js";
import { locateCodexRollout } from "./parsers/codex.js";

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_SUFFIX = ".lock";
/** A scan this recent answers a decision without being repeated. */
const FRESH_MS = 1_000;
/** A display read answers from a scan this old while a newer one runs. */
const DISPLAY_MAX_AGE_MS = 30_000;
const LSOF_TIMEOUT_MS = 2_000;

export type CodexTaskLiveness =
  | { status: "live"; pid: number }
  | { status: "not_live" }
  | { status: "unavailable"; reason: string };

type CodexTaskLockSnapshot =
  | { status: "current"; live: Map<string, number> }
  | { status: "unavailable"; reason: string };

type CompletedScan = { completedAt: number; snapshot: CodexTaskLockSnapshot };

const scans = new Map<string, CompletedScan>();
const running = new Map<string, Promise<CompletedScan>>();
/** Advanced by a cache clear, so a scan that started before it records nothing. */
let generation = 0;
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

/** Interpret one lsof run. lsof exits 1 with no stderr when no process holds a descriptor in the directory: an authoritative empty snapshot. */
function lockSnapshot(
  lockDir: string,
  error: { code?: unknown; message?: string } | null,
  stdout: string,
  stderr: string,
): CodexTaskLockSnapshot {
  if (error && !(error.code === 1 && !stderr.trim())) {
    return { status: "unavailable", reason: stderr.trim() || error.message || String(error.code) };
  }
  return { status: "current", live: parseCodexTaskLockLsof(stdout, lockDir) };
}

/** Scan one lock directory off the event loop; a scan already running is joined. */
function scanLockDir(lockDir: string): Promise<CompletedScan> {
  const inFlight = running.get(lockDir);
  if (inFlight) return inFlight;
  const started = generation;
  const scan = new Promise<CodexTaskLockSnapshot>((resolve) => {
    if (!fs.existsSync(lockDir)) {
      resolve({ status: "unavailable", reason: "Codex thread-writer lock directory is missing" });
      return;
    }
    execFile("lsof", ["-Fpcn", "+D", lockDir], {
      encoding: "utf8",
      timeout: LSOF_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve(lockSnapshot(lockDir, error, String(stdout ?? ""), String(stderr ?? ""))));
  }).then((snapshot) => {
    const completed = { completedAt: Date.now(), snapshot };
    if (started !== generation) return completed;
    scans.set(lockDir, completed);
    running.delete(lockDir);
    if (snapshot.status === "unavailable") reportUnavailable(lockDir, snapshot.reason);
    else reportRecovered(lockDir);
    return completed;
  });
  running.set(lockDir, scan);
  return scan;
}

/** The scan to answer from for a lock directory, or `undefined` when there is none to use. */
type SnapshotPicker = (lockDir: string) => CodexTaskLockSnapshot | undefined;

const SCAN_PENDING: CodexTaskLiveness = {
  status: "unavailable",
  reason: "No Codex thread-writer lock scan has completed recently enough to answer",
};

function readerOver(pick: SnapshotPicker): (sourcePath: string, threadId: string) => CodexTaskLiveness {
  return (sourcePath, threadId) => {
    if (!CODEX_THREAD_ID.test(threadId)) return { status: "not_live" };
    const location = locateCodexRollout(sourcePath);
    if (!location) {
      const reason = "ingested source is outside a Codex rollout root";
      reportUnavailable(sourcePath, reason);
      return { status: "unavailable", reason };
    }
    const snapshot = pick(path.join(location.codexRoot, "thread-writer-locks"));
    if (!snapshot) return SCAN_PENDING;
    if (snapshot.status === "unavailable") return snapshot;
    const pid = snapshot.live.get(threadId);
    return pid ? { status: "live", pid } : { status: "not_live" };
  };
}

function scanCompletedSince(lockDir: string, since: number): CodexTaskLockSnapshot | undefined {
  const scan = scans.get(lockDir);
  return scan && scan.completedAt >= since ? scan.snapshot : undefined;
}

/**
 * Resolve task activity from Codex's own writer-lock ownership, for display.
 *
 * The ingested rollout supplies the exact provider identity and Codex root;
 * Mandible stores no second mutable task-status row. A leftover lock filename
 * is not enough: the Codex process must still hold the descriptor open.
 *
 * This never waits: it answers from the latest scan up to 30 s old and starts
 * a new scan in the background when that one is over a second old, so a
 * polled view is at most one poll behind. A decision that acts on `not_live`
 * uses {@link withFreshCodexTaskLiveness} instead.
 */
export function readCodexTaskLiveness(sourcePath: string, threadId: string): CodexTaskLiveness {
  return readerOver((lockDir) => {
    const now = Date.now();
    const scan = scans.get(lockDir);
    if (!scan || now - scan.completedAt > FRESH_MS) void scanLockDir(lockDir);
    return scan && now - scan.completedAt <= DISPLAY_MAX_AGE_MS ? scan.snapshot : undefined;
  })(sourcePath, threadId);
}

/**
 * Run `judge` against Codex lock scans that completed within a second of this
 * call or during it. `judge` is pure and may run more than once: a pass that
 * asks about a lock directory without such a scan is followed by that scan,
 * off the event loop, and another pass. The last pass's result is returned.
 * A reader the judge returns keeps answering from those scans, and reads a
 * directory without such a scan as unavailable.
 */
export async function withFreshCodexTaskLiveness<T>(
  judge: (read: (sourcePath: string, threadId: string) => CodexTaskLiveness) => T,
): Promise<T> {
  const since = Date.now() - FRESH_MS;
  const settled = new Map<string, CodexTaskLockSnapshot>();
  for (;;) {
    const needed = new Set<string>();
    const result = judge(readerOver((lockDir) => {
      const snapshot = settled.get(lockDir) ?? scanCompletedSince(lockDir, since);
      if (!snapshot) needed.add(lockDir);
      return snapshot;
    }));
    if (needed.size === 0) return result;
    await Promise.all([...needed].map(async (lockDir) => {
      settled.set(lockDir, (await scanLockDir(lockDir)).snapshot);
    }));
  }
}

/** Test seam: forget every scan, and every failure already reported. */
export function clearCodexTaskLivenessCache(): void {
  generation += 1;
  scans.clear();
  running.clear();
  reportedFailures.clear();
}
