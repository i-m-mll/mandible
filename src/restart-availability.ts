import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RESTART_AVAILABILITY_VERSION = 1;
export const RESTART_AVAILABILITY_HISTORY_LIMIT = 20;
export const RESTART_AVAILABILITY_ACTIVE_MAX_AGE_MS = 5 * 60 * 1000;

export type RestartAvailabilityPhase = "rebuilding" | "shutdown";

export interface RestartAvailabilityStats {
  samples_ms: number[];
  average_ms: number | null;
  sample_count: number;
}

export interface ActiveRestartAvailability {
  generation_id: string;
  reason: "self_merge";
  phase: RestartAvailabilityPhase;
  rebuild_started_at_ms: number;
  shutdown_started_at_ms?: number;
  expected_ready_at_ms?: number;
}

export interface RestartAvailabilityCompletion {
  generation_id: string;
  rebuild_started_at_ms: number;
  shutdown_started_at_ms?: number;
  ready_at_ms: number;
  warm_at_ms?: number;
}

/**
 * Versioned, constant-size operational receipt shared by the daemon and CLI.
 * It contains timing metadata only: no paths, credentials, or request bodies.
 */
export interface RestartAvailabilityRecord {
  version: typeof RESTART_AVAILABILITY_VERSION;
  instance_key: string;
  updated_at_ms: number;
  active: ActiveRestartAvailability | null;
  last_completion: RestartAvailabilityCompletion | null;
  blocked_window: RestartAvailabilityStats;
  shutdown_to_ready: RestartAvailabilityStats;
  ready_to_warm: RestartAvailabilityStats;
}

export interface RestartAvailabilityNotice {
  error: "mandible_restarting";
  retryable: true;
  request_sent: false;
  phase: RestartAvailabilityPhase;
  reason: "self_merge";
  retry_after_seconds?: number;
  eta_exceeded_seconds?: number;
  average_seconds?: number;
  sample_count: number;
}

export interface RestartAvailabilityLifecycle {
  markRebuildStarted(generationId?: string): string | null;
  markShutdownStarted(generationId: string): boolean;
  /** Issue a09b4d2 — retire an active window whose rebuild will not restart. */
  markRebuildFailed?(generationId: string): boolean;
}

export interface RestartAvailabilityStoreOptions {
  instanceKey: string;
  filePath?: string;
  now?: () => number;
  historyLimit?: number;
  activeMaxAgeMs?: number;
}

export function getRestartAvailabilityFilePath(): string {
  return process.env.MANDIBLE_RESTART_AVAILABILITY_FILE
    ?? path.join(os.homedir(), ".cache", "mandible", "restart-availability.json");
}

export function restartAvailabilityInstanceKey(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export class RestartAvailabilityStore implements RestartAvailabilityLifecycle {
  private readonly instanceKey: string;
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly historyLimit: number;
  private readonly activeMaxAgeMs: number;

  constructor(options: RestartAvailabilityStoreOptions) {
    this.instanceKey = options.instanceKey;
    this.filePath = options.filePath ?? getRestartAvailabilityFilePath();
    this.now = options.now ?? (() => Date.now());
    this.historyLimit = options.historyLimit ?? RESTART_AVAILABILITY_HISTORY_LIMIT;
    this.activeMaxAgeMs = options.activeMaxAgeMs ?? RESTART_AVAILABILITY_ACTIVE_MAX_AGE_MS;
  }

  read(): RestartAvailabilityRecord | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return null;
    }
    return parseRecord(parsed, this.instanceKey, this.historyLimit);
  }

  markRebuildStarted(generationId: string = randomUUID()): string | null {
    const now = this.now();
    const record = this.recordForWrite(now);
    if (!record) return null;
    const expected = expectedReadyAt(now, record.blocked_window);
    record.active = {
      generation_id: generationId,
      reason: "self_merge",
      phase: "rebuilding",
      rebuild_started_at_ms: now,
      ...(expected === undefined ? {} : { expected_ready_at_ms: expected }),
    };
    record.updated_at_ms = now;
    return this.write(record) ? generationId : null;
  }

  markShutdownStarted(generationId: string): boolean {
    const now = this.now();
    const record = this.read();
    if (!record || !this.activeMatches(record.active, generationId, now)) return false;
    const expected = expectedReadyAt(now, record.shutdown_to_ready);
    record.active = {
      ...record.active,
      phase: "shutdown",
      shutdown_started_at_ms: now,
      ...(expected === undefined ? {} : { expected_ready_at_ms: expected }),
    };
    record.updated_at_ms = now;
    return this.write(record);
  }

  /**
   * Issue a09b4d2 — a rebuild that will not restart the daemon leaves no
   * blocking window behind. No timing sample is recorded for it.
   */
  markRebuildFailed(generationId: string): boolean {
    const record = this.read();
    if (!record?.active || record.active.generation_id !== generationId) return false;
    record.active = null;
    record.updated_at_ms = this.now();
    return this.write(record);
  }

  /** Records mutation-safe readiness and retires the blocking active phase. */
  markReady(): string | null {
    const now = this.now();
    const record = this.read();
    const active = record?.active;
    if (!record || !active || !this.activeMatches(active, active.generation_id, now)) return null;
    record.blocked_window = appendSample(
      record.blocked_window,
      now - active.rebuild_started_at_ms,
      this.historyLimit,
    );
    if (active.shutdown_started_at_ms !== undefined) {
      record.shutdown_to_ready = appendSample(
        record.shutdown_to_ready,
        now - active.shutdown_started_at_ms,
        this.historyLimit,
      );
    }
    record.last_completion = {
      generation_id: active.generation_id,
      rebuild_started_at_ms: active.rebuild_started_at_ms,
      ...(active.shutdown_started_at_ms === undefined
        ? {}
        : { shutdown_started_at_ms: active.shutdown_started_at_ms }),
      ready_at_ms: now,
    };
    record.active = null;
    record.updated_at_ms = now;
    return this.write(record) ? active.generation_id : null;
  }

  /** Records the later non-blocking warm tier without changing ready history. */
  markWarm(generationId: string): boolean {
    const now = this.now();
    const record = this.read();
    const completion = record?.last_completion;
    if (
      !record
      || !completion
      || completion.generation_id !== generationId
      || completion.warm_at_ms !== undefined
      || now < completion.ready_at_ms
      || now - completion.ready_at_ms > this.activeMaxAgeMs
    ) {
      return false;
    }
    record.ready_to_warm = appendSample(
      record.ready_to_warm,
      now - completion.ready_at_ms,
      this.historyLimit,
    );
    record.last_completion = { ...completion, warm_at_ms: now };
    record.updated_at_ms = now;
    return this.write(record);
  }

  currentNotice(): RestartAvailabilityNotice | null {
    const now = this.now();
    const record = this.read();
    const active = record?.active;
    if (!record || !active || !this.activeMatches(active, active.generation_id, now)) return null;
    const stats = active.phase === "shutdown" ? record.shutdown_to_ready : record.blocked_window;
    const notice: RestartAvailabilityNotice = {
      error: "mandible_restarting",
      retryable: true,
      request_sent: false,
      phase: active.phase,
      reason: active.reason,
      sample_count: stats.sample_count,
    };
    if (stats.average_ms !== null) notice.average_seconds = roundTenths(stats.average_ms / 1000);
    if (active.expected_ready_at_ms !== undefined) {
      const remainingMs = active.expected_ready_at_ms - now;
      if (remainingMs >= 0) notice.retry_after_seconds = Math.ceil(remainingMs / 1000);
      else notice.eta_exceeded_seconds = Math.ceil(-remainingMs / 1000);
    }
    return notice;
  }

  private recordForWrite(now: number): RestartAvailabilityRecord | null {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { version?: unknown };
        if (typeof raw.version === "number" && raw.version > RESTART_AVAILABILITY_VERSION) {
          return null;
        }
      } catch {
        // A malformed current-version cache is disposable operational metadata.
      }
    }
    return this.read() ?? emptyRecord(this.instanceKey, now);
  }

  private activeMatches(
    active: ActiveRestartAvailability | null,
    generationId: string,
    now: number,
  ): active is ActiveRestartAvailability {
    return Boolean(
      active
      && active.generation_id === generationId
      && now >= active.rebuild_started_at_ms
      && now - active.rebuild_started_at_ms <= this.activeMaxAgeMs,
    );
  }

  private write(record: RestartAvailabilityRecord): boolean {
    const dir = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      fs.writeFileSync(tempPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(tempPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      return true;
    } catch {
      try { fs.unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
      return false;
    }
  }
}

function emptyStats(): RestartAvailabilityStats {
  return { samples_ms: [], average_ms: null, sample_count: 0 };
}

function emptyRecord(instanceKey: string, now: number): RestartAvailabilityRecord {
  return {
    version: RESTART_AVAILABILITY_VERSION,
    instance_key: instanceKey,
    updated_at_ms: now,
    active: null,
    last_completion: null,
    blocked_window: emptyStats(),
    shutdown_to_ready: emptyStats(),
    ready_to_warm: emptyStats(),
  };
}

function expectedReadyAt(now: number, stats: RestartAvailabilityStats): number | undefined {
  return stats.average_ms === null ? undefined : Math.round(now + stats.average_ms);
}

function appendSample(
  stats: RestartAvailabilityStats,
  durationMs: number,
  limit: number,
): RestartAvailabilityStats {
  if (!Number.isFinite(durationMs) || durationMs < 0) return stats;
  const samples = [...stats.samples_ms, Math.round(durationMs)].slice(-limit);
  return {
    samples_ms: samples,
    average_ms: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    sample_count: samples.length,
  };
}

function parseRecord(
  value: unknown,
  instanceKey: string,
  historyLimit: number,
): RestartAvailabilityRecord | null {
  if (!isObject(value) || value.version !== RESTART_AVAILABILITY_VERSION) return null;
  if (value.instance_key !== instanceKey || !isInteger(value.updated_at_ms)) return null;
  const active = parseActive(value.active);
  if (value.active !== null && !active) return null;
  const completion = parseCompletion(value.last_completion);
  if (value.last_completion !== null && !completion) return null;
  const blocked = parseStats(value.blocked_window, historyLimit);
  const shutdown = parseStats(value.shutdown_to_ready, historyLimit);
  const warm = parseStats(value.ready_to_warm, historyLimit);
  if (!blocked || !shutdown || !warm) return null;
  return {
    version: RESTART_AVAILABILITY_VERSION,
    instance_key: instanceKey,
    updated_at_ms: value.updated_at_ms,
    active,
    last_completion: completion,
    blocked_window: blocked,
    shutdown_to_ready: shutdown,
    ready_to_warm: warm,
  };
}

function parseActive(value: unknown): ActiveRestartAvailability | null {
  if (value === null) return null;
  if (
    !isObject(value)
    || typeof value.generation_id !== "string"
    || value.generation_id.length === 0
    || value.reason !== "self_merge"
    || (value.phase !== "rebuilding" && value.phase !== "shutdown")
    || !isInteger(value.rebuild_started_at_ms)
    || (value.shutdown_started_at_ms !== undefined && !isInteger(value.shutdown_started_at_ms))
    || (value.expected_ready_at_ms !== undefined && !isInteger(value.expected_ready_at_ms))
  ) return null;
  if (value.phase === "shutdown" && value.shutdown_started_at_ms === undefined) return null;
  if (value.phase === "rebuilding" && value.shutdown_started_at_ms !== undefined) return null;
  if (
    value.shutdown_started_at_ms !== undefined
    && value.shutdown_started_at_ms < value.rebuild_started_at_ms
  ) return null;
  return value as unknown as ActiveRestartAvailability;
}

function parseCompletion(value: unknown): RestartAvailabilityCompletion | null {
  if (value === null) return null;
  if (
    !isObject(value)
    || typeof value.generation_id !== "string"
    || value.generation_id.length === 0
    || !isInteger(value.rebuild_started_at_ms)
    || !isInteger(value.ready_at_ms)
    || value.ready_at_ms < value.rebuild_started_at_ms
    || (value.shutdown_started_at_ms !== undefined && !isInteger(value.shutdown_started_at_ms))
    || (value.warm_at_ms !== undefined && !isInteger(value.warm_at_ms))
  ) return null;
  if (
    value.shutdown_started_at_ms !== undefined
    && (value.shutdown_started_at_ms < value.rebuild_started_at_ms
      || value.shutdown_started_at_ms > value.ready_at_ms)
  ) return null;
  if (value.warm_at_ms !== undefined && value.warm_at_ms < value.ready_at_ms) return null;
  return value as unknown as RestartAvailabilityCompletion;
}

function parseStats(value: unknown, historyLimit: number): RestartAvailabilityStats | null {
  if (!isObject(value) || !Array.isArray(value.samples_ms)) return null;
  if (
    value.samples_ms.length > historyLimit
    || !value.samples_ms.every((sample) => isInteger(sample) && sample >= 0)
    || !isInteger(value.sample_count)
    || value.sample_count !== value.samples_ms.length
  ) return null;
  const expectedAverage = value.samples_ms.length === 0
    ? null
    : value.samples_ms.reduce((sum, sample) => sum + sample, 0) / value.samples_ms.length;
  if (value.average_ms !== expectedAverage) return null;
  return {
    samples_ms: [...value.samples_ms],
    average_ms: expectedAverage,
    sample_count: value.samples_ms.length,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function roundTenths(value: number): number {
  return Math.round(value * 10) / 10;
}
