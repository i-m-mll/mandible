import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getDb } from "../db.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import type { RouteRegistrar } from "../server.js";
import type { InstanceRole } from "../types.js";
import { readBody, sendJson } from "./http.js";

const DEFAULT_PROTECTED_BRANCHES = ["main", "develop"];
const INSTRUCTION_TARGETS_KEY = "instructions.targets";
const INSTRUCTION_POST_EXPORT_KEY = "instructions.post_export";
const INSTRUCTION_TARGET_MODES = new Set(["managed-block", "standalone"]);

type InstructionTargetMode = "managed-block" | "standalone";

type InstructionTarget = {
  path: string;
  mode: InstructionTargetMode;
};

type InstructionDeliveryResult = {
  targets: InstructionTarget[];
  postExport: string;
  configuredTargets: boolean;
  preview_only?: boolean;
  configuration_saved?: boolean;
  export: {
    ok: boolean;
    stdout: string;
    stderr: string;
  };
  cleanup: Array<{
    target: InstructionTarget;
    ok: boolean;
    stdout: string;
    stderr: string;
  }>;
};

function normalizeInstructionTargets(value: unknown): InstructionTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const targets: InstructionTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const targetPath = typeof record.path === "string" ? record.path.trim() : "";
    if (!targetPath) {
      continue;
    }
    const mode = typeof record.mode === "string" && INSTRUCTION_TARGET_MODES.has(record.mode)
      ? record.mode as InstructionTargetMode
      : "managed-block";
    const normalizedPath = path.resolve(targetPath);
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    targets.push({ path: normalizedPath, mode });
  }
  return targets;
}

function parseInstructionTargetsSetting(value: string | undefined): InstructionTarget[] {
  if (!value) {
    return [];
  }
  try {
    return normalizeInstructionTargets(JSON.parse(value));
  } catch {
    return [];
  }
}

function defaultInstructionTargets(): InstructionTarget[] {
  const home = os.homedir();
  return [
    { path: path.join(home, ".claude", "CLAUDE.md"), mode: "managed-block" },
    { path: path.join(home, ".codex", "AGENTS.md"), mode: "managed-block" },
  ];
}

function getSettingValue(key: string, fallback = ""): string {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

function setSettingValue(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now());
}

function getConfiguredInstructionTargets(): { targets: InstructionTarget[]; configured: boolean } {
  const raw = getSettingValue(INSTRUCTION_TARGETS_KEY, "");
  const configured = raw.trim().length > 0;
  const targets = parseInstructionTargetsSetting(raw);
  return {
    targets: configured ? targets : defaultInstructionTargets(),
    configured,
  };
}

function resolveRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, "cli", "instructions.sh"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

function runInstructions(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const repoRoot = resolveRepoRoot();
  const script = process.env.MANDIBLE_INSTRUCTIONS_CLI || path.join(repoRoot, "cli", "instructions.sh");
  const nodeDir = path.dirname(process.execPath);
  const pathValue = process.env.PATH ? `${nodeDir}${path.delimiter}${process.env.PATH}` : nodeDir;
  const result = spawnSync("bash", [script, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_BIN: process.env.NODE_BIN || process.execPath,
      PATH: pathValue,
    },
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

function diffRemovedInstructionTargets(
  previousTargets: InstructionTarget[],
  nextTargets: InstructionTarget[],
): InstructionTarget[] {
  const nextKeys = new Set(nextTargets.map((target) => `${target.mode}\t${target.path}`));
  return previousTargets.filter((target) => !nextKeys.has(`${target.mode}\t${target.path}`));
}

function instructionDeliverySnapshot(
  exportResult = { ok: true, stdout: "", stderr: "" },
  previewOnly = false,
): InstructionDeliveryResult {
  const configured = getConfiguredInstructionTargets();
  return {
    targets: configured.targets,
    postExport: getSettingValue(INSTRUCTION_POST_EXPORT_KEY, ""),
    configuredTargets: configured.configured,
    ...(previewOnly ? { preview_only: true } : {}),
    export: exportResult,
    cleanup: [],
  };
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

const DEPRECATED_REAPER_SETTINGS = new Set([
  "reaper_enabled",
  "reaper_claude_idle_minutes",
  "reaper_codex_idle_minutes",
  "reaper_dry_run",
  "reaper_cleanup_orphan_mcps",
]);

// Issue 708dc4c / finding 4 — client-auth settings are not managed through the
// generic settings API. Reads are hidden and writes/reads of a specific key 403.
const PROTECTED_SETTING_KEYS = new Set([
  "client_auth",
  "console_operator_session_id",
  "console_pinned_sessions",
  "user.operator_id",
]);

function isProtectedIdentitySettingKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return PROTECTED_SETTING_KEYS.has(normalized) || normalized.startsWith("client_auth.");
}

function clientAuthSettingForbidden(): { error: string; code: string; hint: string } {
  return {
    error: "Authentication and operator identity settings are not managed through generic settings.",
    code: "identity_setting_protected",
    hint: "Use the explicit /api/client-auth and /api/users/setup authorization paths.",
  };
}

export function registerSettingsRoutes(server: RouteRegistrar, instanceRole: InstanceRole = "main"): void {
  const db = getDb();

  // GET /api/settings — returns all settings as { key: value } object.
  // Issue 708dc4c / finding 4 — `client_auth.*` keys are hidden from the generic
  // settings surface. The pepper lives on disk (never in settings); the mode is
  // read/written only through the dedicated guarded /api/client-auth routes, so
  // it cannot be flipped or an internal secret overwritten via generic settings.
  server.get("/api/settings", (_req, res) => {
    const rows = db
      .prepare("SELECT key, value FROM settings ORDER BY key")
      .all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (isProtectedIdentitySettingKey(row.key)) continue;
      result[row.key] = row.value;
    }
    sendJson(res, 200, result);
  }, { operation: { id: "get:/api/settings", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/settings/instructions-delivery", (_req, res) => {
    sendJson(res, 200, instanceRole === "preview"
      ? instructionDeliverySnapshot({
        ok: false,
        stdout: "",
        stderr: "Instruction export is not run by a preview instance.",
      }, true)
      : instructionDeliverySnapshot());
  }, { operation: { id: "get:/api/settings/instructions-delivery", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.put("/api/settings/instructions-delivery", globalCapabilityRoute("change_settings", (req, res) => {
    const body = readBody<{
      targets?: unknown;
      postExport?: unknown;
      cleanupRemovedTargets?: unknown;
      resetToDefaults?: unknown;
    }>(req);
    const previous = getConfiguredInstructionTargets();
    let nextTargets = previous.targets;
    let targetsChanged = false;

    if (body.resetToDefaults === true) {
      nextTargets = defaultInstructionTargets();
      setSettingValue(INSTRUCTION_TARGETS_KEY, JSON.stringify(nextTargets));
      targetsChanged = true;
    } else if ("targets" in body) {
      nextTargets = normalizeInstructionTargets(body.targets);
      if (nextTargets.length === 0) {
        sendJson(res, 400, { error: "At least one instruction target is required" });
        return;
      }
      setSettingValue(INSTRUCTION_TARGETS_KEY, JSON.stringify(nextTargets));
      targetsChanged = true;
    }

    if ("postExport" in body) {
      if (typeof body.postExport !== "string") {
        sendJson(res, 400, { error: "postExport must be a string" });
        return;
      }
      setSettingValue(INSTRUCTION_POST_EXPORT_KEY, body.postExport.trim());
    }

    if (instanceRole === "preview") {
      const snapshot = instructionDeliverySnapshot({
        ok: false,
        stdout: "",
        stderr: "Settings were saved to the preview database; instruction targets were not installed.",
      }, true);
      snapshot.configuration_saved = true;
      sendJson(res, 200, snapshot);
      return;
    }

    const cleanupResults: InstructionDeliveryResult["cleanup"] = [];
    if (targetsChanged && body.cleanupRemovedTargets === true) {
      for (const oldTarget of diffRemovedInstructionTargets(previous.targets, nextTargets)) {
        const cleanup = runInstructions([
          "cleanup",
          "--target",
          oldTarget.path,
          "--mode",
          oldTarget.mode,
        ]);
        cleanupResults.push({ target: oldTarget, ...cleanup });
        if (!cleanup.ok) {
          sendJson(res, 500, {
            error: `Failed to clean previous instruction target: ${oldTarget.path}`,
            cleanup: cleanupResults,
          });
          return;
        }
      }
    }

    const exportResult = runInstructions(["install"]);
    const snapshot = instructionDeliverySnapshot(exportResult);
    snapshot.cleanup = cleanupResults;
    if (!exportResult.ok) {
      sendJson(res, 500, {
        error: "Instruction export failed after saving settings",
        ...snapshot,
      });
      return;
    }
    sendJson(res, 200, snapshot);
  }), { operation: { id: "put:/api/settings/instructions-delivery", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["ledger:write","files:production","process:external"], requestSchema: null, reportingCategory: "settings" }, fileRpc: "deny" });

  // GET /api/settings/:key — returns single setting value
  server.get("/api/settings/:key", (req, res) => {
    const key = req.params.key;
    if (!key) {
      sendJson(res, 400, { error: "Missing key" });
      return;
    }
    if (isProtectedIdentitySettingKey(key)) {
      sendJson(res, 403, clientAuthSettingForbidden());
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
  }, { operation: { id: "get:/api/settings/:key", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // PUT /api/settings/:key — update a setting
  server.put("/api/settings/:key", globalCapabilityRoute("change_settings", (req, res) => {
    const key = req.params.key;
    if (!key) {
      sendJson(res, 400, { error: "Missing key" });
      return;
    }
    if (isProtectedIdentitySettingKey(key)) {
      sendJson(res, 403, clientAuthSettingForbidden());
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
    if (instanceRole !== "preview" && key in TIER2_MAP) {
      dualWriteDotfilesConf(TIER2_MAP[key], body.value);
    }

    sendJson(res, 200, {
      ok: true,
      key,
      value: body.value,
      deprecated: DEPRECATED_REAPER_SETTINGS.has(key) || undefined,
    });
  }), { operation: { id: "put:/api/settings/:key", effects: ["ledger:write"], requestSchema: null, reportingCategory: "settings" }, fileRpc: "deny" });
}
