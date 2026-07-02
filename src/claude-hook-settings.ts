import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ClaudeSettings = Record<string, unknown>;

interface ClaudeHookHandler {
  type: "command";
  command: string;
  timeout: number;
}

interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeHookHandler[];
}

export interface ClaudeHookSettingsOptions {
  sessionRef: string;
  settingsDir?: string;
  baseSettingsPath?: string | null;
  baseSettings?: ClaudeSettings | null;
}

export interface ClaudeHookSettingsResult {
  settingsPath: string;
  settings: ClaudeSettings;
}

const HOOK_TIMEOUT_SECONDS = 1;
const HOOK_EVENTS = {
  PostToolUse: "mandible-claude-ingest-nudge.sh",
  Stop: "mandible-claude-ingest-nudge.sh",
  Notification: "mandible-claude-notification.sh",
} as const;

const SETTINGS_ARG_NAMES = new Set(["--settings"]);

export function writeMandibleClaudeHookSettings(
  options: ClaudeHookSettingsOptions,
): ClaudeHookSettingsResult {
  const settingsDir = options.settingsDir ?? defaultHookSettingsDir();
  fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  const baseSettings =
    options.baseSettings ??
    (options.baseSettingsPath ? readJsonObject(options.baseSettingsPath) : {});
  const settings = mergeMandibleClaudeHookSettings(baseSettings, options.sessionRef);
  const settingsPath = path.join(settingsDir, `${safeFileSegment(options.sessionRef)}.settings.json`);
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { settingsPath, settings };
}

export function mergeMandibleClaudeHookSettings(
  baseSettings: ClaudeSettings | null | undefined,
  sessionRef: string,
): ClaudeSettings {
  const base = isRecord(baseSettings) ? baseSettings : {};
  const next: ClaudeSettings = { ...base };
  const baseHooks = isRecord(base.hooks) ? base.hooks : {};
  const hooks: Record<string, unknown> = { ...baseHooks };

  for (const [eventName, scriptName] of Object.entries(HOOK_EVENTS)) {
    const command = mandibleHookCommand(scriptName, sessionRef);
    const existingMatchers = Array.isArray(hooks[eventName])
      ? [...hooks[eventName] as unknown[]]
      : [];
    const matcher: ClaudeHookMatcher = {
      matcher: "",
      hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
    };
    hooks[eventName] = appendHookMatcher(existingMatchers, matcher);
  }

  next.hooks = hooks;
  return next;
}

export function injectMandibleClaudeHookSettingsArgs(
  args: string[],
  options: ClaudeHookSettingsOptions,
): string[] {
  const existingSettingsPath = options.baseSettingsPath ?? extractSettingsPath(args);
  const stripped = stripSettingsArgs(args);
  const { settingsPath } = writeMandibleClaudeHookSettings({
    ...options,
    baseSettingsPath: existingSettingsPath,
  });
  return [...stripped, "--settings", settingsPath];
}

export function stripSettingsArgs(args: string[]): string[] {
  const next: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (SETTINGS_ARG_NAMES.has(arg)) {
      i += 1;
      continue;
    }
    next.push(arg);
  }
  return next;
}

export function extractSettingsPath(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if (SETTINGS_ARG_NAMES.has(args[i])) {
      const value = args[i + 1];
      return typeof value === "string" && value.trim() ? value : null;
    }
  }
  return null;
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

function mandibleHookCommand(scriptName: string, sessionRef: string): string {
  return `MANDIBLE_SESSION_REF=${shellQuote(sessionRef)} ${shellQuote(hookScriptPath(scriptName))}`;
}

function hookScriptPath(scriptName: string): string {
  return fileURLToPath(new URL(`../cli/hooks/${scriptName}`, import.meta.url));
}

function defaultHookSettingsDir(): string {
  return path.join(os.homedir(), ".cache", "mandible", "claude-hooks");
}

function readJsonObject(filePath: string): ClaudeSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "session";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
