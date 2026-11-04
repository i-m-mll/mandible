import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { publicCommand } from "./product-resources.js";

const { ownershipConflict } = createRequire(import.meta.url)("../cli/integration-files.cjs");

type ClaudeSettings = Record<string, unknown>;
type ClaudeStatusLine = Record<string, unknown>;
export type ClaudeSettingSource = "user" | "project" | "local";

interface ClaudeHookHandler {
  type: "command";
  command: string;
  timeout: number;
}

interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeHookHandler[];
}

export interface ClaudeIntegrationInstallOptions {
  settingsPath?: string;
  now?: Date;
}

export interface ClaudeIntegrationInstallResult {
  status: "installed" | "unchanged";
  settingsPath: string;
  backupPath: string | null;
  chainedStatusLine: string | null;
}

export interface ClaudeIntegrationUninstallResult {
  status: "uninstalled" | "absent";
  settingsPath: string;
}

export interface ClaudeIntegrationStatusResult {
  status: "installed" | "absent" | "drifted";
  settingsPath: string;
  details: string[];
  chainedStatusLine: string | null;
}

const HOOK_TIMEOUT_SECONDS = 1;
const INTEGRATION_VERSION = 1;
const MANAGED_HOOK_MARKER = "MANDIBLE_MANAGED_CLAUDE_HOOK=1";
const MANAGED_STATUSLINE_MARKER = "MANDIBLE_MANAGED_CLAUDE_STATUSLINE=1";
const MANAGED_METADATA_KEY = "__mandible";
const CLAUDE_INTEGRATION_KEY = "claudeIntegration";
const HOOK_EVENTS = {
  PreToolUse: "mandible-claude-pre-tool-use.sh",
  SessionStart: "mandible-claude-session-start.sh",
  SessionEnd: "mandible-claude-session-end.sh",
  SubagentStart: "mandible-claude-subagent-start.sh",
  SubagentStop: "mandible-claude-subagent-stop.sh",
  PostToolUse: "mandible-claude-ingest-nudge.sh",
  Stop: "mandible-claude-ingest-nudge.sh",
  Notification: "mandible-claude-notification.sh",
} as const;

const PUBLIC_PRE_TOOL_USE_INVOCATION = /(?<![\w.-])mandible\s+hook\s+pre-tool-use(?![\w.-])/;

export function mergeMandibleClaudeHookSettings(
  baseSettings: ClaudeSettings | null | undefined,
  sessionRef: string,
): ClaudeSettings {
  return mergeMandibleClaudeHookSettingsWithMetadata(baseSettings, sessionRef).settings;
}

function mergeMandibleClaudeHookSettingsWithMetadata(
  baseSettings: ClaudeSettings | null | undefined,
  sessionRef: string,
): { settings: ClaudeSettings; chainedStatusLine: string | null } {
  const base = isRecord(baseSettings) ? baseSettings : {};
  const next: ClaudeSettings = { ...base };
  const baseHooks = isRecord(base.hooks) ? base.hooks : {};
  const hooks: Record<string, unknown> = removeManagedHooks(baseHooks);

  for (const [eventName, scriptName] of Object.entries(HOOK_EVENTS)) {
    // Claude Code runs an event's hooks in parallel and keeps only one updatedInput,
    // so a managed copy beside a handler composing this hook would race with it.
    if (eventName === "PreToolUse" && settingsDeliverPreToolUseProjection(base)) continue;
    const command = mandibleHookCommand(scriptName, sessionRef, MANAGED_HOOK_MARKER);
    const existingMatchers = Array.isArray(hooks[eventName])
      ? [...hooks[eventName] as unknown[]]
      : [];
    const matcher: ClaudeHookMatcher = {
      matcher: eventName === "PreToolUse" ? "Bash|mcp__mandible__.*" : "",
      hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
    };
    hooks[eventName] = appendHookMatcher(existingMatchers, matcher);
  }

  next.hooks = hooks;
  const statusLineMerge = mergeMandibleStatusLine(base.statusLine, sessionRef);
  next.statusLine = statusLineMerge.statusLine;
  return { settings: next, chainedStatusLine: statusLineMerge.chainedStatusLine };
}

export function settingsDeliverPreToolUseProjection(settings: ClaudeSettings): boolean {
  return hookCommands(settings.hooks, "PreToolUse").some((command) => (
    !isManagedHookCommand(command)
    && PUBLIC_PRE_TOOL_USE_INVOCATION.test(command.replace(/['"\\]/g, ""))
  ));
}

export function loadedSettingsDeliverPreToolUseProjection(sources: readonly ClaudeSettingSource[], cwd: string): boolean {
  const files: Record<ClaudeSettingSource, string> = {
    user: defaultClaudeUserSettingsPath(),
    project: path.join(cwd, ".claude", "settings.json"),
    local: path.join(cwd, ".claude", "settings.local.json"),
  };
  return sources.some((source) => settingsDeliverPreToolUseProjection(readJsonObject(files[source])));
}

export function installUserClaudeIntegration(
  options: ClaudeIntegrationInstallOptions = {},
): ClaudeIntegrationInstallResult {
  const settingsPath = options.settingsPath ?? defaultClaudeUserSettingsPath();
  const conflict = ownershipConflict(settingsPath);
  if (conflict) throw new Error(conflict);
  const existingText = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
  const baseSettings = existingText.trim() ? JSON.parse(existingText) : {};
  if (!isRecord(baseSettings)) throw new Error(`Expected settings object: ${settingsPath}`);
  const merge = mergeMandibleClaudeHookSettingsWithMetadata(baseSettings, "external");
  const metadata = integrationMetadata(baseSettings);
  const backupPath = metadata ? metadata.backupPath ?? null : createSettingsBackup(settingsPath, existingText, options.now);
  const nextSettings = withIntegrationMetadata(merge.settings, {
    version: INTEGRATION_VERSION,
    backupPath,
    priorStatusLine: merge.chainedStatusLine,
  });
  const nextText = `${JSON.stringify(nextSettings, null, 2)}\n`;
  if (existingText === nextText) {
    return { status: "unchanged", settingsPath, backupPath, chainedStatusLine: merge.chainedStatusLine };
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, nextText, { mode: 0o600 });
  return { status: "installed", settingsPath, backupPath, chainedStatusLine: merge.chainedStatusLine };
}

export function uninstallUserClaudeIntegration(
  options: ClaudeIntegrationInstallOptions = {},
): ClaudeIntegrationUninstallResult {
  const settingsPath = options.settingsPath ?? defaultClaudeUserSettingsPath();
  const conflict = ownershipConflict(settingsPath);
  if (conflict) throw new Error(conflict);
  if (!fs.existsSync(settingsPath)) {
    return { status: "absent", settingsPath };
  }
  const currentText = fs.readFileSync(settingsPath, "utf8");
  const settings = parseJsonObject(currentText);
  if (!isIntegrationInstalled(settings)) {
    return { status: "absent", settingsPath };
  }
  const metadata = integrationMetadata(settings);
  const restored = restoreExactBackupIfUnchanged(settingsPath, currentText, metadata);
  if (restored) {
    return { status: "uninstalled", settingsPath };
  }
  const next = removeIntegrationMetadata({
    ...settings,
    hooks: removeManagedHooks(settings.hooks),
    statusLine: isMandibleStatusLineCommand(normalizeStatusLineCommand(settings.statusLine))
      ? restorePriorStatusLine(metadata?.priorStatusLine) : settings.statusLine,
  });
  if (next.statusLine === undefined) {
    delete next.statusLine;
  }
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  fs.writeFileSync(settingsPath, nextText, { mode: 0o600 });
  return { status: "uninstalled", settingsPath };
}

export function getUserClaudeIntegrationStatus(
  options: ClaudeIntegrationInstallOptions = {},
): ClaudeIntegrationStatusResult {
  const settingsPath = options.settingsPath ?? defaultClaudeUserSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { status: "absent", settingsPath, details: ["settings_missing"], chainedStatusLine: null };
  }
  const settings = readJsonObject(settingsPath);
  const details: string[] = [];
  const metadata = integrationMetadata(settings);
  if (!metadata) {
    return { status: "absent", settingsPath, details: ["metadata_missing"], chainedStatusLine: null };
  }
  for (const [eventName, scriptName] of Object.entries(HOOK_EVENTS)) {
    const satisfied = hasManagedHook(settings.hooks, eventName, scriptName)
      || (eventName === "PreToolUse" && settingsDeliverPreToolUseProjection(settings));
    if (!satisfied) {
      details.push(`hook_missing:${eventName}`);
    }
  }
  const statusLine = normalizeStatusLineCommand(settings.statusLine);
  if (!statusLine || !statusLine.includes(MANAGED_STATUSLINE_MARKER) || !hasHookInvocation(statusLine, "mandible-claude-statusline.sh")) {
    details.push("statusline_missing");
  }
  const status = details.length > 0 ? "drifted" : "installed";
  return {
    status,
    settingsPath,
    details,
    chainedStatusLine: typeof metadata.priorStatusLine === "string" ? metadata.priorStatusLine : null,
  };
}

function appendHookMatcher(existing: unknown[], matcher: ClaudeHookMatcher): unknown[] {
  const command = matcher.hooks[0]?.command;
  const alreadyPresent = existing.some((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      return false;
    }
    return entry.hooks.some((hook) => isRecord(hook) && hook.command === command);
  });
  return alreadyPresent ? existing : [...existing, matcher];
}

function mandibleHookCommand(scriptName: string, sessionRef: string, marker?: string): string {
  const prefix = marker ? `${marker} ` : "";
  return `${prefix}MANDIBLE_SESSION_REF=${shellQuote(sessionRef)} ${hookInvocation(scriptName)}`;
}

function mergeMandibleStatusLine(
  existingStatusLine: unknown,
  sessionRef: string,
): { statusLine: ClaudeStatusLine; chainedStatusLine: string | null } {
  const existingCommand = normalizeStatusLineCommand(existingStatusLine);
  const chainedStatusLine = existingCommand && !isMandibleStatusLineCommand(existingCommand)
    ? existingCommand
    : chainedStatusLineFromManagedCommand(existingCommand);
  const command = mandibleStatusLineCommand(sessionRef, chainedStatusLine);
  return {
    statusLine: {
      type: "command",
      command,
    },
    chainedStatusLine,
  };
}

function mandibleStatusLineCommand(sessionRef: string, chainedStatusLine: string | null): string {
  const parts = [
    MANAGED_STATUSLINE_MARKER,
    `MANDIBLE_SESSION_REF=${shellQuote(sessionRef)}`,
  ];
  if (chainedStatusLine) {
    parts.push(`MANDIBLE_CHAINED_STATUSLINE=${shellQuote(chainedStatusLine)}`);
  }
  parts.push(hookInvocation("mandible-claude-statusline.sh"));
  return parts.join(" ");
}

function chainedStatusLineFromManagedCommand(command: string | null): string | null {
  if (!command || !isMandibleStatusLineCommand(command)) {
    return null;
  }
  const match = command.match(/MANDIBLE_CHAINED_STATUSLINE='((?:'\\''|[^'])*)'/);
  if (!match) {
    return null;
  }
  return match[1].replace(/'\\''/g, "'");
}

function normalizeStatusLineCommand(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (isRecord(value) && typeof value.command === "string") {
    const trimmed = value.command.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function isMandibleStatusLineCommand(command: string | null): boolean {
  return Boolean(command?.includes(MANAGED_STATUSLINE_MARKER) || (command && hasHookInvocation(command, "mandible-claude-statusline.sh")));
}

function hookInvocation(scriptName: string): string {
  const hook = scriptName.replace(/^mandible-claude-/, "").replace(/\.sh$/, "");
  const invocation = publicCommand("hook", hook);
  return [invocation.command, ...invocation.args].map(shellQuote).join(" ");
}

function hasHookInvocation(command: string, scriptName: string): boolean {
  return command.includes(scriptName) || command.includes(hookInvocation(scriptName));
}

function defaultClaudeUserSettingsPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
}

function readJsonObject(filePath: string): ClaudeSettings {
  try {
    return parseJsonObject(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function parseJsonObject(text: string): ClaudeSettings {
  try {
    const parsed = text.trim() ? JSON.parse(text) as unknown : {};
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function createSettingsBackup(settingsPath: string, existingText: string, now: Date = new Date()): string | null {
  if (!existingText) {
    return null;
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = `${settingsPath}.mandible-backup-${stamp}`;
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(backupPath, existingText, { mode: 0o600 });
  return backupPath;
}

function integrationMetadata(settings: ClaudeSettings): {
  version?: unknown;
  backupPath?: string | null;
  priorStatusLine?: unknown;
} | null {
  const root = settings[MANAGED_METADATA_KEY];
  if (!isRecord(root)) {
    return null;
  }
  const metadata = root[CLAUDE_INTEGRATION_KEY];
  return isRecord(metadata) ? metadata : null;
}

function withIntegrationMetadata(
  settings: ClaudeSettings,
  metadata: { version: number; backupPath: string | null; priorStatusLine: string | null },
): ClaudeSettings {
  const root = isRecord(settings[MANAGED_METADATA_KEY])
    ? { ...settings[MANAGED_METADATA_KEY] as Record<string, unknown> }
    : {};
  root[CLAUDE_INTEGRATION_KEY] = metadata;
  return { ...settings, [MANAGED_METADATA_KEY]: root };
}

function removeIntegrationMetadata(settings: ClaudeSettings): ClaudeSettings {
  const next = { ...settings };
  const root = isRecord(next[MANAGED_METADATA_KEY])
    ? { ...next[MANAGED_METADATA_KEY] as Record<string, unknown> }
    : null;
  if (!root) {
    return next;
  }
  delete root[CLAUDE_INTEGRATION_KEY];
  if (Object.keys(root).length === 0) {
    delete next[MANAGED_METADATA_KEY];
  } else {
    next[MANAGED_METADATA_KEY] = root;
  }
  return next;
}

function isIntegrationInstalled(settings: ClaudeSettings): boolean {
  return integrationMetadata(settings) !== null;
}

function removeManagedHooks(hooksValue: unknown): Record<string, unknown> {
  const hooks = isRecord(hooksValue) ? hooksValue : {};
  const next: Record<string, unknown> = {};
  for (const [eventName, eventValue] of Object.entries(hooks)) {
    if (!Array.isArray(eventValue)) {
      next[eventName] = eventValue;
      continue;
    }
    const filtered = eventValue
      .map((entry) => removeManagedHooksFromMatcher(entry))
      .filter((entry) => entry !== null);
    if (filtered.length > 0) {
      next[eventName] = filtered;
    }
  }
  return next;
}

function removeManagedHooksFromMatcher(entry: unknown): unknown | null {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return entry;
  }
  const hooks = entry.hooks.filter((hook) => {
    if (!isRecord(hook) || typeof hook.command !== "string") {
      return true;
    }
    return !isManagedHookCommand(hook.command);
  });
  if (hooks.length === 0) {
    return null;
  }
  return { ...entry, hooks };
}

function hookCommands(hooksValue: unknown, eventName: string): string[] {
  const matchers = isRecord(hooksValue) ? hooksValue[eventName] : null;
  if (!Array.isArray(matchers)) {
    return [];
  }
  return matchers.flatMap((entry) => (
    isRecord(entry) && Array.isArray(entry.hooks)
      ? entry.hooks.flatMap((hook) => (isRecord(hook) && typeof hook.command === "string" ? [hook.command] : []))
      : []
  ));
}

function hasManagedHook(hooksValue: unknown, eventName: string, scriptName: string): boolean {
  return hookCommands(hooksValue, eventName).some((command) => (
    command.includes(MANAGED_HOOK_MARKER) && hasHookInvocation(command, scriptName)
  ));
}

function isManagedHookCommand(command: string): boolean {
  return command.includes(MANAGED_HOOK_MARKER);
}

function restorePriorStatusLine(priorStatusLine: unknown): ClaudeStatusLine | undefined {
  if (typeof priorStatusLine !== "string" || !priorStatusLine.trim()) {
    return undefined;
  }
  return { type: "command", command: priorStatusLine };
}

function restoreExactBackupIfUnchanged(
  settingsPath: string,
  currentText: string,
  metadata: { backupPath?: string | null } | null,
): boolean {
  const backupPath = metadata?.backupPath;
  if (!backupPath || !fs.existsSync(backupPath)) {
    return false;
  }
  const backupText = fs.readFileSync(backupPath, "utf8");
  const backupSettings = parseJsonObject(backupText);
  const merge = mergeMandibleClaudeHookSettingsWithMetadata(backupSettings, "external");
  const expected = withIntegrationMetadata(merge.settings, {
    version: INTEGRATION_VERSION,
    backupPath,
    priorStatusLine: merge.chainedStatusLine,
  });
  const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
  if (currentText !== expectedText) {
    return false;
  }
  fs.writeFileSync(settingsPath, backupText, { mode: 0o600 });
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
