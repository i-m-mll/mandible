import { getDb } from "../db.js";
import {
  findExistingMetadataBackupPaths,
  getDefaultMetadataBackupPath,
  writeMetadataBackup,
} from "../ledger/backup.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import type { RouteRegistrar } from "../server.js";
import { getBoolSetting, getIntSetting, getStrSetting } from "./settings.js";

// Bug: 4cf8cbb — scheduled backup with Settings tab control

export type BackupStatus = {
  enabled: boolean;
  interval_hours: number;
  destination: string;
  last_run_at: number | null;
  last_size_bytes: number | null;
  last_error: string | null;
  /**
   * Backups found on disk, newest layout first (issue 24f0316). Backups written
   * before the durable/cache split are still under `~/.cache/mandible/backups`
   * and are reported, not moved.
   */
  existing_backup_paths: string[];
};

function getBackupStatus(): BackupStatus {
  const enabled = getBoolSetting("backup.enabled", true);
  const interval_hours = getIntSetting("backup.interval_hours", 6);
  const destination = getStrSetting("backup.destination", "") || getDefaultMetadataBackupPath();

  const lastRunStr = getStrSetting("backup.last_run_at", "");
  const last_run_at = lastRunStr ? parseInt(lastRunStr, 10) : null;

  const lastSizeStr = getStrSetting("backup.last_size_bytes", "");
  const last_size_bytes = lastSizeStr ? parseInt(lastSizeStr, 10) : null;

  const last_error = getStrSetting("backup.last_error", "") || null;

  return {
    enabled,
    interval_hours,
    destination,
    last_run_at,
    last_size_bytes,
    last_error,
    existing_backup_paths: findExistingMetadataBackupPaths(),
  };
}

function writeSetting(key: string, value: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, now);
}

function runBackup(): {
  ok: boolean;
  size_bytes?: number;
  path?: string;
  destination?: string;
  error?: string;
} {
  const now = Date.now();
  writeSetting("backup.last_run_at", String(now));
  const destination = getStrSetting("backup.destination", "") || getDefaultMetadataBackupPath();
  try {
    const result = writeMetadataBackup(getDb(), destination);
    writeSetting("backup.last_size_bytes", String(result.size_bytes));
    writeSetting("backup.last_error", "");
    return {
      ok: true,
      size_bytes: result.size_bytes,
      path: result.path,
      destination: result.path,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    writeSetting("backup.last_error", errorMsg);
    return { ok: false, error: errorMsg };
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startBackupScheduler(): void {
  const enabled = getBoolSetting("backup.enabled", true);
  if (!enabled) {
    return;
  }

  const interval_hours = getIntSetting("backup.interval_hours", 6);
  const intervalMs = interval_hours * 3600 * 1_000;

  // Run immediately if never run or overdue
  const lastRunStr = getStrSetting("backup.last_run_at", "");
  const lastRunAt = lastRunStr ? parseInt(lastRunStr, 10) : null;
  const now = Date.now();
  if (lastRunAt === null || now - lastRunAt >= intervalMs) {
    // Run after a short delay to let the server finish starting up
    const immediateTimer = setTimeout(() => {
      try {
        runBackup();
      } catch {
        // Scheduler errors are non-fatal
      }
    }, 5_000);
    if (typeof immediateTimer === "object" && "unref" in immediateTimer) {
      immediateTimer.unref();
    }
  }

  schedulerTimer = setInterval(() => {
    try {
      runBackup();
    } catch {
      // Scheduler errors are non-fatal
    }
  }, intervalMs);

  if (typeof schedulerTimer === "object" && "unref" in schedulerTimer) {
    schedulerTimer.unref();
  }
}

export function stopBackupScheduler(): void {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerBackupRoutes(server: RouteRegistrar): void {
  // GET /api/backup/status
  server.get("/api/backup/status", (_req, res) => {
    res.status(200).json(getBackupStatus());
  }, { operation: { id: "get:/api/backup/status", effects: ["files:production"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // POST /api/backup/run
  server.post("/api/backup/run", globalCapabilityRoute("backup", (_req, res) => {
    const result = runBackup();
    res.status(200).json(result);
  }), { operation: { id: "post:/api/backup/run", effects: ["files:production"], requestSchema: null, reportingCategory: "backup" }, fileRpc: "deny" });

  // PUT /api/backup/settings
  server.put("/api/backup/settings", globalCapabilityRoute("backup", (req, res) => {
    const body = (req.body ?? {}) as {
      enabled?: unknown;
      interval_hours?: unknown;
      destination?: unknown;
    };

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean" });
        return;
      }
      writeSetting("backup.enabled", String(body.enabled));
    }

    if (body.interval_hours !== undefined) {
      if (typeof body.interval_hours !== "number" || !Number.isFinite(body.interval_hours)) {
        res.status(400).json({ error: "interval_hours must be a number" });
        return;
      }
      writeSetting("backup.interval_hours", String(body.interval_hours));
    }

    if (body.destination !== undefined) {
      if (typeof body.destination !== "string" || body.destination.trim() === "") {
        res.status(400).json({ error: "destination must be a non-empty string" });
        return;
      }
      writeSetting("backup.destination", body.destination.trim());
    }

    // Reschedule with updated settings
    stopBackupScheduler();
    startBackupScheduler();

    res.status(200).json({ ok: true });
  }), { operation: { id: "put:/api/backup/settings", effects: ["files:production"], requestSchema: null, reportingCategory: "backup" }, fileRpc: "deny" });
}
