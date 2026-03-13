import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { getDb } from "../db.js";

const execFileAsync = promisify(execFile);

const REAPER_PLIST_PATH = path.join(
  os.homedir(),
  "Library/LaunchAgents/com.mll.claude-reaper.plist"
);

/**
 * Load or unload the reaper launchd job.
 * This is the authoritative on/off switch — the job should not be running
 * when the user has disabled the reaper.
 * Bug: 372981c
 */
async function manageReaperLaunchd(enabled: boolean): Promise<void> {
  if (!fs.existsSync(REAPER_PLIST_PATH)) return;
  const action = enabled ? "load" : "unload";
  try {
    await execFileAsync("launchctl", [action, REAPER_PLIST_PATH]);
  } catch {
    // Non-fatal: launchctl may fail if job is already in desired state
    // (e.g. unloading an already-unloaded job returns an error)
  }
}
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";

const DEFAULT_PROTECTED_BRANCHES = ["main", "develop"];

function sendJson(res: ResponseLike, code: number, payload: unknown): void {
  res.status(code).json(payload);
}

function readBody<T>(req: RequestLike): T {
  return (req.body ?? {}) as T;
}

/**
 * Parse the protected_branches setting value into a normalized array.
 * Trims whitespace, lowercases, and filters empty entries.
 */
export function parseProtectedBranches(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Get the list of protected branches from the settings table.
 * Falls back to ['main', 'develop'] if the setting is missing or empty.
 */
export function getProtectedBranches(): string[] {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get("protected_branches") as { value: string } | undefined;
  if (!row || !row.value.trim()) {
    return DEFAULT_PROTECTED_BRANCHES;
  }
  const parsed = parseProtectedBranches(row.value);
  return parsed.length > 0 ? parsed : DEFAULT_PROTECTED_BRANCHES;
}

/** Get a boolean setting with fallback default. */
export function getBoolSetting(key: string, defaultValue: boolean): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return defaultValue;
  return row.value === "true";
}

/** Get an integer setting with fallback default. */
export function getIntSetting(key: string, defaultValue: number): number {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return defaultValue;
  const parsed = parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/** Get a string setting with fallback default. */
export function getStrSetting(key: string, defaultValue: string): string {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return defaultValue;
  return row.value;
}

const DOTFILES_CONF_PATH = path.join(os.homedir(), ".config", "dotfiles.conf");
const REAPER_CONF_PATH = path.join(os.homedir(), ".config", "claude-reaper", "config");

/**
 * Update a single variable in dotfiles.conf.
 * If the `export VAR=` line exists, replace its value; otherwise append it.
 */
function dualWriteDotfilesConf(envVar: string, value: string): void {
  try {
    let content = "";
    if (fs.existsSync(DOTFILES_CONF_PATH)) {
      content = fs.readFileSync(DOTFILES_CONF_PATH, "utf-8");
    }
    const pattern = new RegExp(`^(export\\s+${envVar}=).*$`, "m");
    const newLine = `export ${envVar}="${value}"`;
    if (pattern.test(content)) {
      content = content.replace(pattern, newLine);
    } else {
      content = content.trimEnd() + "\n" + newLine + "\n";
    }
    fs.writeFileSync(DOTFILES_CONF_PATH, content, "utf-8");
  } catch {
    // Non-fatal: log but don't fail the API response
  }
}

/**
 * Update a single variable in ~/.config/claude-reaper/config.
 * If the `export VAR=` line exists, replace its value; otherwise append it.
 * Creates the directory and file if they don't exist.
 */
export function dualWriteReaperConf(envVar: string, value: string): void {
  try {
    const dir = path.dirname(REAPER_CONF_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let content = "";
    if (fs.existsSync(REAPER_CONF_PATH)) {
      content = fs.readFileSync(REAPER_CONF_PATH, "utf-8");
    }
    const pattern = new RegExp(`^(?:export\\s+)?${envVar}=.*$`, "m");
    const newLine = `export ${envVar}="${value}"`;
    if (pattern.test(content)) {
      content = content.replace(pattern, newLine);
    } else {
      content = content.trimEnd() + "\n" + newLine + "\n";
    }
    fs.writeFileSync(REAPER_CONF_PATH, content, "utf-8");
  } catch {
    // Non-fatal: log but don't fail the API response
  }
}

/** Sync all reaper_* settings from DB to config file on startup. */
export function syncReaperSettingsToConfigFile(): void {
  const REAPER_SETTING_MAP: Record<string, string[]> = {
    reaper_enabled: ["CLAUDE_ENABLED", "CODEX_ENABLED"],
    reaper_claude_idle_minutes: ["CLAUDE_IDLE_THRESHOLD_MINUTES"],
    reaper_codex_idle_minutes: ["CODEX_IDLE_THRESHOLD_MINUTES"],
    reaper_dry_run: ["DRY_RUN"],
    reaper_cleanup_orphan_mcps: ["CLEANUP_ORPHAN_MCPS"],
  };
  const db = getDb();
  for (const [key, envVars] of Object.entries(REAPER_SETTING_MAP)) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (row) {
      for (const envVar of envVars) {
        dualWriteReaperConf(envVar, row.value);
      }
    }
  }

  // Re-establish launchd state on startup to match stored setting
  // Bug: 372981c — Mandible restart must restore correct launchd state
  const reaperEnabledRow = db.prepare("SELECT value FROM settings WHERE key = 'reaper_enabled'").get() as { value: string } | undefined;
  if (reaperEnabledRow) {
    manageReaperLaunchd(reaperEnabledRow.value === "true").catch(() => {});
  }
}

export function registerSettingsRoutes(server: RouteRegistrar): void {
  const db = getDb();

  // GET /api/settings — returns all settings as { key: value } object
  server.get("/api/settings", (_req, res) => {
    const rows = db
      .prepare("SELECT key, value FROM settings ORDER BY key")
      .all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    sendJson(res, 200, result);
  });

  // GET /api/settings/:key — returns single setting value
  server.get("/api/settings/:key", (req, res) => {
    const key = req.params.key;
    if (!key) {
      sendJson(res, 400, { error: "Missing key" });
      return;
    }
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (!row) {
      sendJson(res, 404, { error: "Setting not found" });
      return;
    }
    sendJson(res, 200, { key, value: row.value });
  });

  // PUT /api/settings/:key — update a setting
  server.put("/api/settings/:key", (req, res) => {
    const key = req.params.key;
    if (!key) {
      sendJson(res, 400, { error: "Missing key" });
      return;
    }
    const body = readBody<{ value?: unknown }>(req);
    if (typeof body.value !== "string") {
      sendJson(res, 400, { error: "Missing or invalid value (must be string)" });
      return;
    }
    const now = Date.now();
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, body.value, now);

    // Dual-write tier 2 settings to dotfiles.conf
    const TIER2_MAP: Record<string, string> = {
      theme: "DOTFILES_THEME",
      prompt: "DOTFILES_PROMPT",
      multiplexer: "DOTFILES_MULTIPLEXER",
    };
    if (key in TIER2_MAP) {
      dualWriteDotfilesConf(TIER2_MAP[key], body.value);
    }

    // Dual-write reaper settings to ~/.config/claude-reaper/config
    const REAPER_MAP: Record<string, string[]> = {
      reaper_enabled: ["CLAUDE_ENABLED", "CODEX_ENABLED"],
      reaper_claude_idle_minutes: ["CLAUDE_IDLE_THRESHOLD_MINUTES"],
      reaper_codex_idle_minutes: ["CODEX_IDLE_THRESHOLD_MINUTES"],
      reaper_dry_run: ["DRY_RUN"],
      reaper_cleanup_orphan_mcps: ["CLEANUP_ORPHAN_MCPS"],
    };
    if (key in REAPER_MAP) {
      for (const envVar of REAPER_MAP[key]) {
        dualWriteReaperConf(envVar, body.value);
      }
    }

    // Manage launchd job for reaper on/off toggle
    if (key === "reaper_enabled") {
      manageReaperLaunchd(body.value === "true").catch(() => {});
    }

    sendJson(res, 200, { ok: true, key, value: body.value });
  });
}
