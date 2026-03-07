import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../db.js";
const DEFAULT_PROTECTED_BRANCHES = ["main", "develop"];
function sendJson(res, code, payload) {
    res.status(code).json(payload);
}
function readBody(req) {
    return (req.body ?? {});
}
/**
 * Parse the protected_branches setting value into a normalized array.
 * Trims whitespace, lowercases, and filters empty entries.
 */
export function parseProtectedBranches(value) {
    return value
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}
/**
 * Get the list of protected branches from the settings table.
 * Falls back to ['main', 'develop'] if the setting is missing or empty.
 */
export function getProtectedBranches() {
    const db = getDb();
    const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("protected_branches");
    if (!row || !row.value.trim()) {
        return DEFAULT_PROTECTED_BRANCHES;
    }
    const parsed = parseProtectedBranches(row.value);
    return parsed.length > 0 ? parsed : DEFAULT_PROTECTED_BRANCHES;
}
/** Get a boolean setting with fallback default. */
export function getBoolSetting(key, defaultValue) {
    const db = getDb();
    const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(key);
    if (!row)
        return defaultValue;
    return row.value === "true";
}
/** Get an integer setting with fallback default. */
export function getIntSetting(key, defaultValue) {
    const db = getDb();
    const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(key);
    if (!row)
        return defaultValue;
    const parsed = parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}
/** Get a string setting with fallback default. */
export function getStrSetting(key, defaultValue) {
    const db = getDb();
    const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(key);
    if (!row)
        return defaultValue;
    return row.value;
}
const DOTFILES_CONF_PATH = path.join(os.homedir(), ".config", "dotfiles.conf");
/**
 * Update a single variable in dotfiles.conf.
 * If the `export VAR=` line exists, replace its value; otherwise append it.
 */
function dualWriteDotfilesConf(envVar, value) {
    try {
        let content = "";
        if (fs.existsSync(DOTFILES_CONF_PATH)) {
            content = fs.readFileSync(DOTFILES_CONF_PATH, "utf-8");
        }
        const pattern = new RegExp(`^(export\\s+${envVar}=).*$`, "m");
        const newLine = `export ${envVar}="${value}"`;
        if (pattern.test(content)) {
            content = content.replace(pattern, newLine);
        }
        else {
            content = content.trimEnd() + "\n" + newLine + "\n";
        }
        fs.writeFileSync(DOTFILES_CONF_PATH, content, "utf-8");
    }
    catch {
        // Non-fatal: log but don't fail the API response
    }
}
export function registerSettingsRoutes(server) {
    const db = getDb();
    // GET /api/settings — returns all settings as { key: value } object
    server.get("/api/settings", (_req, res) => {
        const rows = db
            .prepare("SELECT key, value FROM settings ORDER BY key")
            .all();
        const result = {};
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
            .get(key);
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
        const body = readBody(req);
        if (typeof body.value !== "string") {
            sendJson(res, 400, { error: "Missing or invalid value (must be string)" });
            return;
        }
        const now = Date.now();
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, body.value, now);
        // Dual-write tier 2 settings to dotfiles.conf
        const TIER2_MAP = {
            theme: "DOTFILES_THEME",
            prompt: "DOTFILES_PROMPT",
            multiplexer: "DOTFILES_MULTIPLEXER",
        };
        if (key in TIER2_MAP) {
            dualWriteDotfilesConf(TIER2_MAP[key], body.value);
        }
        sendJson(res, 200, { ok: true, key, value: body.value });
    });
}
