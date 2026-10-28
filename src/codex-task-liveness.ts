import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { getDaemonLogger } from "./daemon-log.js";
import { locateCodexRollout } from "./parsers/codex.js";

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_SUFFIX = ".lock";
/** A display read starts a new scan once the latest is this old. */
const REVALIDATE_MS = 1_000;
/** A display read answers from a scan this old while a newer one runs. */
const DISPLAY_MAX_AGE_MS = 30_000;
const LSOF_TIMEOUT_MS = 2_000;
const DIAGNOSTIC_TEXT_BYTES = 4096;

type LockScanExecutionError = {
  code?: string | number | null; message?: string; signal?: string | null; killed?: boolean;
  errno?: number; syscall?: string; path?: string;
};

export interface CodexLockScanFailure {
  command: "lsof";
  code: string | number | null;
  signal: string | null;
  killed: boolean | null;
  errno: number | null;
  syscall: string | null;
  path: string | null;
  message: string;
  timeout_ms: number;
  duration_ms: number;
  /** Elapsed budget is evidence, not an assertion that the timeout caused termination. */
  deadline_elapsed: boolean;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

function boundedText(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= DIAGNOSTIC_TEXT_BYTES) return text;
  const marker = "\n...[truncated]...\n";
  const half = Math.floor((DIAGNOSTIC_TEXT_BYTES - Buffer.byteLength(marker)) / 2);
  let prefixEnd = half;
  let suffixStart = bytes.length - half;
  while ((bytes[prefixEnd] & 0xc0) === 0x80) prefixEnd -= 1;
  while ((bytes[suffixStart] & 0xc0) === 0x80) suffixStart += 1;
  return bytes.subarray(0, prefixEnd).toString("utf8") + marker + bytes.subarray(suffixStart).toString("utf8");
}

export type CodexTaskLiveness =
  | { status: "live"; pid: number }
  | { status: "not_live" }
  | { status: "unavailable"; reason: string; subprocess?: CodexLockScanFailure };

type CodexTaskLockSnapshot =
  | { status: "current"; live: Map<string, number> }
  | { status: "unavailable"; reason: string; subprocess?: CodexLockScanFailure };

/** `seq` orders scans by when they started, so a decision can require one that started after it began. */
type CompletedScan = { seq: number; completedAt: number; snapshot: CodexTaskLockSnapshot };
type RunningScan = { seq: number; done: Promise<CompletedScan> };

const scans = new Map<string, CompletedScan>();
const running = new Map<string, RunningScan>();
let scansStarted = 0;
/** Advanced by a cache clear, so a scan that started before it records nothing. */
let generation = 0;
/** The last reported failure per lock directory or rollout, so an outage logs once per change. */
const reportedFailures = new Map<string, string>();

/**
 * Log a liveness check that could not complete, loudly and once per distinct
 * failure: every holder behind it reads as `unknown` until it recovers.
 */
function reportUnavailable(key: string, reason: string, subprocess?: CodexLockScanFailure): void {
  if (reportedFailures.get(key) === reason) return;
  reportedFailures.set(key, reason);
  getDaemonLogger()("error", "codex_task_liveness_unavailable", {
    target: key, reason: boundedText(reason),
    ...(Buffer.byteLength(reason) > DIAGNOSTIC_TEXT_BYTES ? { reason_truncated: true } : {}),
    ...(subprocess ? { subprocess } : {}),
  });
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
  error: LockScanExecutionError | null,
  stdout: string,
  stderr: string,
  durationMs: number,
): CodexTaskLockSnapshot {
  if (error && !(error.code === 1 && !stderr.trim())) {
    return { status: "unavailable", reason: stderr.trim() || error.message || String(error.code), subprocess: {
      command: "lsof", code: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? null,
      errno: error.errno ?? null, syscall: error.syscall ? boundedText(error.syscall) : null,
      path: error.path ? boundedText(error.path) : null, message: boundedText(error.message ?? ""),
      timeout_ms: LSOF_TIMEOUT_MS, duration_ms: durationMs, deadline_elapsed: durationMs >= LSOF_TIMEOUT_MS,
      stdout: boundedText(stdout), stderr: boundedText(stderr),
      stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr),
      stdout_truncated: Buffer.byteLength(stdout) > DIAGNOSTIC_TEXT_BYTES,
      stderr_truncated: Buffer.byteLength(stderr) > DIAGNOSTIC_TEXT_BYTES,
    } };
  }
  return { status: "current", live: parseCodexTaskLockLsof(stdout, lockDir) };
}

/** Scan one lock directory off the event loop, joining a running scan only if it started after scan number `after`. */
function scanLockDir(lockDir: string, after = 0): Promise<CompletedScan> {
  const inFlight = running.get(lockDir);
  if (inFlight && inFlight.seq > after) return inFlight.done;
  const started = generation;
  const seq = ++scansStarted;
  const done = new Promise<CodexTaskLockSnapshot>((resolve) => {
    if (!fs.existsSync(lockDir)) {
      resolve({ status: "unavailable", reason: "Codex thread-writer lock directory is missing" });
      return;
    }
    const executionStarted = performance.now();
    execFile("lsof", ["-Fpcn", "+D", lockDir], {
      encoding: "utf8",
      timeout: LSOF_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve(lockSnapshot(lockDir, error, String(stdout ?? ""), String(stderr ?? ""), performance.now() - executionStarted)));
  }).then((snapshot) => {
    const completed = { seq, completedAt: Date.now(), snapshot };
    if (started !== generation) return completed;
    if (running.get(lockDir)?.seq === seq) running.delete(lockDir);
    if ((scans.get(lockDir)?.seq ?? 0) > seq) return completed;
    scans.set(lockDir, completed);
    if (snapshot.status === "unavailable") reportUnavailable(lockDir, snapshot.reason, snapshot.subprocess);
    else reportRecovered(lockDir);
    return completed;
  });
  running.set(lockDir, { seq, done });
  return done;
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
    if (!scan || now - scan.completedAt > REVALIDATE_MS) void scanLockDir(lockDir);
    return scan && now - scan.completedAt <= DISPLAY_MAX_AGE_MS ? scan.snapshot : undefined;
  })(sourcePath, threadId);
}

/**
 * Run `judge` against Codex lock scans that started after this call did, so
 * no lock taken before the decision began can be missed. Concurrent decisions
 * share such scans; none answers from an earlier one. `judge` is pure and may
 * run more than once: a pass that asks about a lock directory without such a
 * scan is followed by that scan, off the event loop, and another pass. The
 * last pass's result is returned. A reader the judge returns keeps answering
 * from those scans, and reads a directory without such a scan as unavailable.
 */
export async function withFreshCodexTaskLiveness<T>(
  judge: (read: (sourcePath: string, threadId: string) => CodexTaskLiveness) => T,
): Promise<T> {
  const after = scansStarted;
  const settled = new Map<string, CodexTaskLockSnapshot>();
  for (;;) {
    const needed = new Set<string>();
    const result = judge(readerOver((lockDir) => {
      const latest = scans.get(lockDir);
      const snapshot = settled.get(lockDir) ?? (latest && latest.seq > after ? latest.snapshot : undefined);
      if (!snapshot) needed.add(lockDir);
      return snapshot;
    }));
    if (needed.size === 0) return result;
    await Promise.all([...needed].map(async (lockDir) => {
      settled.set(lockDir, (await scanLockDir(lockDir, after)).snapshot);
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
