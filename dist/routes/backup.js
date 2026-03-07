import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getDb } from "../db.js";
import { getBoolSetting, getIntSetting, getStrSetting } from "./settings.js";
// Bug: 4cf8cbb — scheduled backup with Settings tab control
const BACKUP_SCRIPT = path.join(os.homedir(), ".dotfiles", "bin", "mandible-backup");
const BACKUP_OUTPUT = path.join(os.homedir(), ".dotfiles", "private", "backups", "mandible-metadata.sql");
function getBackupStatus() {
    const enabled = getBoolSetting("backup.enabled", true);
    const interval_hours = getIntSetting("backup.interval_hours", 6);
    const lastRunStr = getStrSetting("backup.last_run_at", "");
    const last_run_at = lastRunStr ? parseInt(lastRunStr, 10) : null;
    const lastSizeStr = getStrSetting("backup.last_size_bytes", "");
    const last_size_bytes = lastSizeStr ? parseInt(lastSizeStr, 10) : null;
    const last_error = getStrSetting("backup.last_error", "") || null;
    return { enabled, interval_hours, last_run_at, last_size_bytes, last_error };
}
function writeSetting(key, value) {
    const db = getDb();
    const now = Date.now();
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, now);
}
/**
 * Run mandible-backup synchronously and record the result in settings.
 * Returns { ok, size_bytes?, error? }.
 */
function runBackup() {
    if (!fs.existsSync(BACKUP_SCRIPT)) {
        const error = `mandible-backup not found at ${BACKUP_SCRIPT}`;
        writeSetting("backup.last_error", error);
        writeSetting("backup.last_run_at", String(Date.now()));
        return { ok: false, error };
    }
    const result = spawnSync(BACKUP_SCRIPT, [], {
        timeout: 30_000,
        encoding: "utf8",
    });
    const now = Date.now();
    writeSetting("backup.last_run_at", String(now));
    if (result.error || result.status !== 0) {
        const errorMsg = result.error?.message ??
            result.stderr?.trim() ??
            `exit code ${result.status ?? "unknown"}`;
        writeSetting("backup.last_error", errorMsg);
        return { ok: false, error: errorMsg };
    }
    // Record file size from stat (reliable even if output format changes)
    let size_bytes;
    try {
        const stat = fs.statSync(BACKUP_OUTPUT);
        size_bytes = stat.size;
        writeSetting("backup.last_size_bytes", String(size_bytes));
    }
    catch {
        // Non-fatal: file might not exist yet on first run failure
    }
    writeSetting("backup.last_error", "");
    return { ok: true, size_bytes };
}
// ── Scheduler ────────────────────────────────────────────────────────────────
let schedulerTimer = null;
export function startBackupScheduler() {
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
            }
            catch {
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
        }
        catch {
            // Scheduler errors are non-fatal
        }
    }, intervalMs);
    if (typeof schedulerTimer === "object" && "unref" in schedulerTimer) {
        schedulerTimer.unref();
    }
}
export function stopBackupScheduler() {
    if (schedulerTimer !== null) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
    }
}
// ── Route registration ────────────────────────────────────────────────────────
export function registerBackupRoutes(server) {
    // GET /api/backup/status
    server.get("/api/backup/status", (_req, res) => {
        res.status(200).json(getBackupStatus());
    });
    // POST /api/backup/run
    server.post("/api/backup/run", (_req, res) => {
        const result = runBackup();
        res.status(200).json(result);
    });
    // PUT /api/backup/settings
    server.put("/api/backup/settings", (req, res) => {
        const body = (req.body ?? {});
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
        // Reschedule with updated settings
        stopBackupScheduler();
        startBackupScheduler();
        res.status(200).json({ ok: true });
    });
}
