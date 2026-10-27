import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { getDb } from "../db.js";
import { isProtectedIdentitySettingKey } from "../settings-key-policy.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import type { RouteRegistrar } from "../server.js";
import type { InstanceRole } from "../types.js";
import { readBody, sendJson } from "./http.js";
import { notifyProtectionInputsChanged } from "../protection-inputs.js";
import { CHILD_RETENTION_SETTINGS_SCHEMA, CHILD_RETENTION_SETTINGS_KEY } from "../conversations/retention-contract.js";
import { readChildRetentionSettings, writeChildRetentionSettings } from "../conversations/retention-state.js";

import { INTEGRATION_ACTION, readOptionalIntegrations, applyOptionalIntegration } from "../optional-integrations.js";

const { ownershipConflict } = createRequire(import.meta.url)("../../cli/integration-files.cjs") as { ownershipConflict(target: string): string | null };

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
  conflicts: Array<{ path: string; detail: string }>;
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
    targets,
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

function runInstructions(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const repoRoot = resolveRepoRoot();
  const script = process.env.MANDIBLE_INSTRUCTIONS_CLI || path.join(repoRoot, "cli", "instructions.sh");
  const nodeDir = path.dirname(process.execPath);
  const pathValue = process.env.PATH ? `${nodeDir}${path.delimiter}${process.env.PATH}` : nodeDir;
  return new Promise(resolve => {
    execFile("bash", [script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NODE_BIN: process.env.NODE_BIN || process.execPath, PATH: pathValue },
      encoding: "utf8",
      timeout: 30_000,
    }, (error, stdout, stderr) => resolve({ ok: error === null, stdout, stderr: stderr || (error ? String(error) : "") }));
  });
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
    conflicts: configured.targets.flatMap(target => {
      try { const detail = ownershipConflict(target.path); return detail ? [{ path: target.path, detail }] : []; }
      catch (error) { return [{ path: target.path, detail: String(error) }]; }
    }),
    ...(previewOnly ? { preview_only: true } : {}),
    export: exportResult,
    cleanup: [],
  };
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

function clientAuthSettingForbidden(): { error: string; code: string; hint: string } {
  return {
    error: "Authentication and operator identity settings are not managed through generic settings.",
    code: "identity_setting_protected",
    hint: "Use the explicit /api/client-auth and /api/users/setup authorization paths.",
  };
}

export function registerSettingsRoutes(server: RouteRegistrar, instanceRole: InstanceRole = "main"): void {
  const db = getDb();

  server.get("/api/settings/integrations", (_req, res) => {
    sendJson(res, 200, readOptionalIntegrations(instanceRole === "preview"));
  }, { operation: { id: "get:/api/settings/integrations", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
  server.put("/api/settings/integrations", globalCapabilityRoute("change_settings", (req, res) => {
    const parsed = INTEGRATION_ACTION.safeParse(readBody(req));
    if (!parsed.success) { sendJson(res, 400, { error: "Invalid integration choice" }); return; }
    const result = applyOptionalIntegration(parsed.data, instanceRole === "preview");
    sendJson(res, result.ok ? 200 : 409, result.ok ? result.value : { error: result.error });
  }), { operation: { id: "put:/api/settings/integrations", effects: ["files:production"], requestSchema: INTEGRATION_ACTION, reportingCategory: "settings" }, fileRpc: "deny" });

  server.get("/api/settings/child-retention", (_req, res) => {
    sendJson(res, 200, readChildRetentionSettings(db));
  }, { operation: { id: "get:/api/settings/child-retention", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
  server.put("/api/settings/child-retention", globalCapabilityRoute("change_settings", (req, res) => {
    const parsed = CHILD_RETENTION_SETTINGS_SCHEMA.safeParse(readBody(req));
    if (!parsed.success) { sendJson(res, 400, { error: "Invalid child retention settings", details: parsed.error.issues }); return; }
    writeChildRetentionSettings(db, parsed.data);
    sendJson(res, 200, parsed.data);
  }), { operation: { id: "put:/api/settings/child-retention", effects: ["ledger:write"], requestSchema: CHILD_RETENTION_SETTINGS_SCHEMA, reportingCategory: "settings" }, fileRpc: "deny" });

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

  server.put("/api/settings/instructions-delivery", globalCapabilityRoute("change_settings", async (req, res) => {
    const body = readBody<{
      targets?: unknown;
      postExport?: unknown;
      cleanupRemovedTargets?: unknown;
      resetToDefaults?: unknown;
    }>(req);
    if (("targets" in body && (!Array.isArray(body.targets) || body.targets.some(target =>
      !target || typeof target !== "object" || typeof target.path !== "string" || !path.isAbsolute(target.path) || !INSTRUCTION_TARGET_MODES.has(target.mode))))
      || ("postExport" in body && typeof body.postExport !== "string")) {
      sendJson(res, 400, { error: "Select absolute instruction destinations, valid modes, and a string post-export command" });
      return;
    }
    const previous = getConfiguredInstructionTargets();
    let nextTargets = previous.targets;
    let targetsChanged = false;

    if (body.resetToDefaults === true) {
      nextTargets = [];
      setSettingValue(INSTRUCTION_TARGETS_KEY, JSON.stringify(nextTargets));
      targetsChanged = true;
    } else if ("targets" in body) {
      nextTargets = normalizeInstructionTargets(body.targets);
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
        const cleanup = await runInstructions([
          "cleanup",
          "--target",
          oldTarget.path,
          "--mode",
          oldTarget.mode,
        ]);
        cleanupResults.push({ target: oldTarget, ...cleanup });
        if (!cleanup.ok) {
          const snapshot = instructionDeliverySnapshot({ ok: false, stdout: "", stderr: `Optional cleanup failed: ${oldTarget.path}. ${cleanup.stderr}` });
          snapshot.configuration_saved = true;
          snapshot.cleanup = cleanupResults;
          sendJson(res, 200, snapshot);
          return;
        }
      }
    }

    const exportResult = await runInstructions(["install"]);
    const snapshot = instructionDeliverySnapshot(exportResult);
    snapshot.cleanup = cleanupResults;
    snapshot.configuration_saved = true;
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
    if (key === CHILD_RETENTION_SETTINGS_KEY) {
      let value: unknown;
      try { value = JSON.parse(body.value); } catch { sendJson(res, 400, { error: "Invalid child retention settings" }); return; }
      const parsed = CHILD_RETENTION_SETTINGS_SCHEMA.safeParse(value);
      if (!parsed.success) { sendJson(res, 400, { error: "Invalid child retention settings" }); return; }
      writeChildRetentionSettings(db, parsed.data);
      sendJson(res, 200, { ok: true, key, value: JSON.stringify(parsed.data) });
      return;
    }
    const now = Date.now();
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, body.value, now);
    if (key === "protected_branches") notifyProtectionInputsChanged("setting:protected_branches");

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
