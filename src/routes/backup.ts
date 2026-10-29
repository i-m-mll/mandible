import { getDb } from "../db.js";
import {
  findExistingMetadataBackupPaths,
  getDefaultMetadataBackupPath,
} from "../ledger/backup.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import type { RouteRegistrar } from "../server.js";
import { MetadataBackupService } from "../metadata-backup-service.js";

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

function getBackupStatus(service: MetadataBackupService): BackupStatus {
  const enabled = service.setting("backup.enabled", "true") === "true";
  const interval_hours = service.integerSetting("backup.interval_hours", 6);
  const destination = service.setting("backup.destination", "") || getDefaultMetadataBackupPath();

  const lastRunStr = service.setting("backup.last_run_at", "");
  const last_run_at = lastRunStr ? parseInt(lastRunStr, 10) : null;

  const lastSizeStr = service.setting("backup.last_size_bytes", "");
  const last_size_bytes = lastSizeStr ? parseInt(lastSizeStr, 10) : null;

  const last_error = service.setting("backup.last_error", "") || null;

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

// ── Route registration ────────────────────────────────────────────────────────

export function registerBackupRoutes(server: RouteRegistrar, service = new MetadataBackupService(getDb())): MetadataBackupService {
  // GET /api/backup/status
  server.get("/api/backup/status", (_req, res) => {
    res.status(200).json(getBackupStatus(service));
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/backup/status", effects: ["files:production"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // POST /api/backup/run
  server.post("/api/backup/run", globalCapabilityRoute("backup", async (_req, res) => {
    const result = await service.run();
    res.status(200).json(result);
  }), { localCliCredential: {"mode":"omit"}, operation: { id: "post:/api/backup/run", effects: ["files:production"], requestSchema: null, reportingCategory: "backup" }, fileRpc: "deny" });

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
      service.updateSetting("backup.enabled", String(body.enabled));
    }

    if (body.interval_hours !== undefined) {
      if (typeof body.interval_hours !== "number" || !Number.isFinite(body.interval_hours)) {
        res.status(400).json({ error: "interval_hours must be a number" });
        return;
      }
      service.updateSetting("backup.interval_hours", String(body.interval_hours));
    }

    if (body.destination !== undefined) {
      if (typeof body.destination !== "string" || body.destination.trim() === "") {
        res.status(400).json({ error: "destination must be a non-empty string" });
        return;
      }
      service.updateSetting("backup.destination", body.destination.trim());
    }

    // Reschedule with updated settings
    service.reschedule();

    res.status(200).json({ ok: true });
  }), { localCliCredential: {"mode":"omit"}, operation: { id: "put:/api/backup/settings", effects: ["files:production"], requestSchema: null, reportingCategory: "backup" }, fileRpc: "deny" });
  return service;
}
