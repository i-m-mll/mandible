/**
 * Claude lane policy — Issue 8aadf70.
 *
 * Released Mandible ships only sanctioned Claude integration lanes:
 *
 * - the Claude Agent SDK lane (`@anthropic-ai/claude-agent-sdk`) — the default
 *   for every Claude session, with real permission gating through `canUseTool`;
 * - the documented headless spawn lane (`claude -p --output-format stream-json`);
 * - a visible passthrough terminal the operator types into directly;
 * - local transcript ingestion of files the operator already owns.
 *
 * The Mandible-owned Claude *PTY* lane is a different thing: it reimplements a
 * headless terminal, classifies Claude Code's TUI chrome, parses its permission
 * menus, answers them with synthetic keystrokes, and loads an undocumented
 * development channel to inject messages into a running CLI. That is acceptable
 * for a developer to run locally against their own account, but it is not
 * something Mandible ships or documents.
 *
 * This module is the single seam every caller consults. It is deliberately the
 * only place that knows the setting key, so a future local-only overlay can own
 * the whole lane (registering its own backend) without the public build
 * carrying dormant scraping behaviour.
 *
 * Gating is total: when the lane is off, Claude PTY/Channel sessions cannot be
 * created, existing Claude PTY sessions do not start, screen-model
 * classification and permission-menu parsing never engage for Claude, and the
 * `--dangerously-load-development-channels` flag is never appended.
 */

import { inspectDbBinding, type Db } from "./db.js";

/** Settings-table key for the local-only Claude PTY lane opt-in. Default off. */
export const CLAUDE_PTY_LANE_SETTING_KEY = "claude_pty_lane_enabled";

/** Environment escape hatch for the same opt-in (wins over the setting). */
export const CLAUDE_PTY_LANE_ENV_KEY = "MANDIBLE_CLAUDE_PTY_LANE";

/** Sanctioned default backend for a Claude console session. */
export const DEFAULT_CLAUDE_BACKEND_TYPE = "sdk" as const;

/**
 * Default SDK permission posture. Never `bypassPermissions`: the SDK's
 * `canUseTool` callback drives Mandible's permission cards, so gating is real
 * rather than reimplemented. Operators can still override per session through
 * `PATCH /api/console/sessions/:id/options`.
 */
export const DEFAULT_SDK_PERMISSION_MODE = "default" as const;

export const CLAUDE_PTY_LANE_DISABLED_CODE = "claude_pty_lane_disabled";

export const CLAUDE_PTY_LANE_DISABLED_MESSAGE =
  "The Claude PTY/Channel lane is disabled. Claude sessions use the Agent SDK lane " +
  "(or the headless `claude -p` spawn lane). Set the " +
  `\`${CLAUDE_PTY_LANE_SETTING_KEY}\` setting to \`true\` to enable the local-only ` +
  "terminal-driving lane for development.";

/** Thrown when a caller asks for a Claude lane the release build does not ship. */
export class ClaudeLaneDisabledError extends Error {
  readonly code = CLAUDE_PTY_LANE_DISABLED_CODE;
  readonly status = 400;

  constructor(message: string = CLAUDE_PTY_LANE_DISABLED_MESSAGE) {
    super(message);
    this.name = "ClaudeLaneDisabledError";
  }
}

export function isClaudeCommand(command: string | null | undefined): boolean {
  return typeof command === "string" && command.trim().toLowerCase() === "claude";
}

function readBooleanSwitch(value: string | undefined | null): boolean | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return null;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return null;
}

function readLaneSetting(db?: Db): boolean | null {
  // Deliberately peek rather than `getDb()`: this gate is consulted from hot
  // paths (screen classification, launch-arg construction) that must never be
  // the thing that opens a database. With no database bound the answer is "not
  // enabled", which is the safe direction.
  const handle = db ?? inspectDbBinding().db;
  if (!handle) return null;
  try {
    const row = handle
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(CLAUDE_PTY_LANE_SETTING_KEY) as { value: string } | undefined;
    return readBooleanSwitch(row?.value);
  } catch {
    // Schema not migrated yet (early boot, bare fixtures): fail closed.
    return null;
  }
}

/**
 * Whether the local-only Claude PTY lane is enabled on this install.
 * Off unless an operator deliberately turned it on.
 */
export function isClaudePtyLaneEnabled(db?: Db): boolean {
  const envSwitch = readBooleanSwitch(process.env[CLAUDE_PTY_LANE_ENV_KEY]);
  if (envSwitch !== null) return envSwitch;
  return readLaneSetting(db) ?? false;
}

/**
 * Whether a (command, backend_type) pair names the gated Claude terminal-driving
 * lane. Codex, Gemini, and shell PTY sessions are unaffected — the concern is
 * programmatic parsing and keystroke injection into Claude Code specifically.
 */
export function isGatedClaudeLane(
  command: string | null | undefined,
  backendType: string | null | undefined,
): boolean {
  return isClaudeCommand(command) && backendType === "pty";
}

/** Throws `ClaudeLaneDisabledError` if this lane is not shippable and not enabled. */
export function assertClaudeLaneAllowed(
  command: string | null | undefined,
  backendType: string | null | undefined,
  db?: Db,
): void {
  if (!isGatedClaudeLane(command, backendType)) return;
  if (isClaudePtyLaneEnabled(db)) return;
  throw new ClaudeLaneDisabledError();
}

/**
 * Claude billing posture for a spawned session — Issue 8aadf70 item 5.
 *
 * Anthropic's Claude Code legal guidance separates subscriber OAuth credentials
 * from developer API-key authentication. Which one a spawned session lands on is
 * decided by the daemon's environment, so Mandible must never let it be a silent
 * inheritance: the posture is logged at spawn and surfaced on the session.
 */
export type AnthropicBillingMode = "api_key" | "subscription";

export interface AnthropicBillingPosture {
  mode: AnthropicBillingMode;
  /** Env var that decided the posture, when one did. */
  source: string | null;
  note: string;
}

const API_KEY_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

export function describeAnthropicBilling(
  env: Record<string, string | undefined> = process.env,
): AnthropicBillingPosture {
  const source = API_KEY_ENV_KEYS.find((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (source) {
    return {
      mode: "api_key",
      source,
      note:
        `${source} is set in the daemon environment, so this Claude session bills to ` +
        "the Anthropic API, not to a Claude subscription.",
    };
  }
  return {
    mode: "subscription",
    source: null,
    note:
      "No Anthropic API key in the daemon environment; this Claude session uses the " +
      "local Claude Code credentials and their subscription limits.",
  };
}
