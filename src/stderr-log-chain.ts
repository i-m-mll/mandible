import { createHash } from "node:crypto";
import fs from "node:fs";
import { RuntimeHealthObservationError } from "./runtime-health-contract.js";

/**
 * The rotated stderr log as one verifiable chain.
 *
 * Rotation moves the live file's bytes into `<log>.1` and then appends a
 * `stderr_log_rotated` record to the live file naming that segment's byte count
 * and sha256. Each segment therefore carries the record of the segment before
 * it, so a reader can follow the live file back through `.1`, `.2`, … and prove
 * that it has read every byte rotation retained, in order, with no segment
 * missing, replaced or shifted underneath it.
 */
export const STDERR_LOG_ROTATED = "stderr_log_rotated";

/** Upper bound on the bytes one coverage walk reads, across all segments. */
export const STDERR_LOG_COVERAGE_LIMIT = 128 * 1024 * 1024;

const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

export interface StderrLogFile {
  path: string;
  dev: number;
  ino: number;
  size: number;
}

export interface StderrLogSegment {
  path: string;
  bytes: number;
  sha256: string;
}

export interface StderrLogCoverage {
  /** Rotated segments the coverage spans, oldest first. Empty when startup is in the live file. */
  segments: StderrLogSegment[];
  /** The live file as resolution read it; it may only grow afterwards. */
  live: { bytes: number; sha256: string };
  /** Byte offset of the startup line in the oldest covered file. */
  offset: number;
  startupTime: string;
}

export function stderrLogRotationRecord(segment: { bytes: number; sha256: string }, time = new Date()): string {
  return `${JSON.stringify({
    level: "info",
    message: STDERR_LOG_ROTATED,
    event: STDERR_LOG_ROTATED,
    time: time.toISOString(),
    segment_bytes: segment.bytes,
    segment_sha256: segment.sha256,
  })}\n`;
}

function coverageFailure(code: string, message: string, evidence: unknown = null): RuntimeHealthObservationError {
  return new RuntimeHealthObservationError(code, message, evidence);
}

const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Stream `[start, end)` of an open file as whole lines, yielding the event loop
 * between chunks so a reader inside the daemon never stalls it. Newline
 * splitting is done on bytes, which is safe for UTF-8. A final unterminated
 * line is emitted as a line.
 */
async function streamLines(
  fd: number,
  start: number,
  end: number,
  onChunk: (bytes: Buffer, position: number) => void,
  onLine: (line: string, offset: number) => void,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let carry: Buffer = Buffer.alloc(0);
  let carryOffset = start;
  let position = start;
  while (position < end) {
    const read = fs.readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, end - position), position);
    if (read === 0) throw coverageFailure("log_changed", "Daemon log ended before its observed size.", { position, end });
    const chunk = buffer.subarray(0, read);
    onChunk(chunk, position);
    let lineStart = 0;
    for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1)) {
      const line = carry.length ? Buffer.concat([carry, chunk.subarray(lineStart, index)]) : chunk.subarray(lineStart, index);
      if (line.length) onLine(line.toString("utf8"), carryOffset);
      carry = Buffer.alloc(0);
      lineStart = index + 1;
      carryOffset = position + lineStart;
    }
    carry = Buffer.concat([carry, chunk.subarray(lineStart)]);
    position += read;
    await yieldTurn();
  }
  if (carry.length) onLine(carry.toString("utf8"), carryOffset);
}

function eventOf(line: string, event: string): Record<string, unknown> | null {
  if (!line.includes(event)) return null;
  try {
    const row = JSON.parse(line);
    return row && (row.message || row.event) === event ? row : null;
  } catch {
    return null;
  }
}

interface ScannedFile {
  sha256: string;
  bytes: number;
  rotation: { bytes: number; sha256: string } | null;
  startup: { offset: number; time: string } | null;
}

async function scanFile(fd: number, end: number, budget: { limit: number; remaining: number }): Promise<ScannedFile> {
  budget.remaining -= end;
  if (budget.remaining < 0) throw coverageFailure("log_coverage_limit", `Current daemon startup exceeds the ${budget.limit} byte observation coverage limit; preserve the log and arrange an explicitly authorized fresh runtime launch.`);
  const digest = createHash("sha256");
  let rotation: ScannedFile["rotation"] = null;
  let rotations = 0;
  let startup: ScannedFile["startup"] = null;
  await streamLines(fd, 0, end, chunk => digest.update(chunk), (line, offset) => {
    const started = eventOf(line, "server_started");
    if (started) startup = { offset, time: String(started.time) };
    const rotated = eventOf(line, STDERR_LOG_ROTATED);
    if (!rotated) return;
    rotations++;
    const bytes = rotated.segment_bytes;
    const sha256 = rotated.segment_sha256;
    rotation = Number.isSafeInteger(bytes) && (bytes as number) >= 0 && typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256)
      ? { bytes: bytes as number, sha256 }
      : null;
    if (!rotation) throw coverageFailure("log_coverage_malformed", "Daemon log rotation record is malformed.", { line });
  });
  if (rotations > 1) throw coverageFailure("log_coverage_malformed", "Daemon log segment holds more than one rotation record.", { rotations });
  return { sha256: digest.digest("hex"), bytes: end, rotation, startup };
}

function openLive(live: StderrLogFile): number {
  const fd = fs.openSync(live.path, "r");
  const stat = fs.fstatSync(fd);
  if (stat.dev !== live.dev || stat.ino !== live.ino || stat.size < live.size) {
    fs.closeSync(fd);
    throw coverageFailure("log_changed", "Daemon log rotated or truncated.", { observed: live, current: { dev: stat.dev, ino: stat.ino, size: stat.size } });
  }
  return fd;
}

function openSegment(segment: StderrLogSegment): number | null {
  let fd: number;
  try {
    fd = fs.openSync(segment.path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const size = fs.fstatSync(fd).size;
  if (size !== segment.bytes) {
    fs.closeSync(fd);
    throw coverageFailure("log_coverage_broken", "Rotated daemon log segment differs from its rotation record.", { segment, size });
  }
  return fd;
}

/**
 * Locate the newest `server_started` line, walking from the live file back
 * through rotated segments, and prove each link. The line must identify the
 * process that started at `processStartedAt`.
 */
export async function resolveStderrLogCoverage(
  live: StderrLogFile,
  processStartedAt: string,
  { limit = STDERR_LOG_COVERAGE_LIMIT }: { limit?: number } = {},
): Promise<StderrLogCoverage> {
  const budget = { limit, remaining: limit };
  const segments: StderrLogSegment[] = [];
  let expected: StderrLogSegment | null = null;
  let liveRead: StderrLogCoverage["live"] | null = null;
  for (let depth = 0; ; depth++) {
    const fd = expected ? openSegment(expected) : openLive(live);
    if (fd === null) throw coverageFailure("log_coverage_expired", "Current daemon startup precedes the retained log segments.", { missing: expected, segments });
    let scanned: ScannedFile;
    try {
      scanned = await scanFile(fd, expected ? expected.bytes : live.size, budget);
    } finally {
      fs.closeSync(fd);
    }
    liveRead ??= { bytes: scanned.bytes, sha256: scanned.sha256 };
    if (expected) {
      if (scanned.sha256 !== expected.sha256) throw coverageFailure("log_coverage_broken", "Rotated daemon log segment differs from its rotation record.", { segment: expected, sha256: scanned.sha256 });
      segments.unshift(expected);
    }
    if (scanned.startup) {
      const time = Date.parse(scanned.startup.time);
      const processTime = Date.parse(processStartedAt);
      if (!Number.isFinite(time) || !Number.isFinite(processTime) || time < processTime - 1000 || time > processTime + 60000) {
        throw coverageFailure("log_startup_mismatch", "Daemon log startup does not identify the current process.", { startup: scanned.startup, processStartedAt });
      }
      return { segments, live: liveRead, offset: scanned.startup.offset, startupTime: scanned.startup.time };
    }
    if (!scanned.rotation) {
      throw coverageFailure("log_startup_absent", depth === 0
        ? "Current daemon startup is absent from its actual log."
        : "Current daemon startup is absent from the rotated log chain, and its oldest segment has no rotation record.", { segments });
    }
    expected = { path: `${live.path}.${depth + 1}`, ...scanned.rotation };
  }
}

/**
 * Stream every covered line, from the startup line through the live file's
 * current end, re-verifying each rotated segment against its record and the
 * live file's resolved prefix. Returns the digest and byte count of exactly the
 * covered bytes.
 */
export async function readStderrLogCoverage(
  coverage: StderrLogCoverage,
  live: StderrLogFile,
  onLine: (line: string) => void,
): Promise<{ sha256: string; bytes: number }> {
  const covered = createHash("sha256");
  let bytes = 0;
  const files = [
    ...coverage.segments.map((segment, index) => ({ segment, start: index === 0 ? coverage.offset : 0 })),
    { segment: null, start: coverage.segments.length ? 0 : coverage.offset },
  ];
  for (const { segment, start } of files) {
    const fd = segment ? openSegment(segment) : openLive(live);
    if (fd === null) throw coverageFailure("log_changed", "Rotated daemon log segment disappeared during observation.", { segment });
    try {
      const end = segment ? segment.bytes : fs.fstatSync(fd).size;
      const expected = segment ? { bytes: segment.bytes, sha256: segment.sha256 } : coverage.live;
      if (end < expected.bytes) throw coverageFailure("log_changed", "Daemon log rotated or truncated during observation.", { expected, end });
      const verified = createHash("sha256");
      await streamLines(fd, 0, end, (chunk, position) => {
        if (position < expected.bytes) verified.update(chunk.subarray(0, expected.bytes - position));
        if (position + chunk.length > start) {
          const from = Math.max(0, start - position);
          covered.update(chunk.subarray(from));
          bytes += chunk.length - from;
        }
      }, (line, offset) => { if (offset >= start) onLine(line); });
      if (verified.digest("hex") !== expected.sha256) {
        throw coverageFailure(segment ? "log_coverage_broken" : "log_changed", segment
          ? "Rotated daemon log segment changed during observation."
          : "Daemon log rotated or truncated during observation.", { segment, expected });
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return { sha256: covered.digest("hex"), bytes };
}
