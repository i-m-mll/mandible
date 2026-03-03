import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "./types.js";

export interface NavigateResult {
  ok: boolean;
  message?: string;
}

const COMMON_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

const ROBUST_PATH_SUFFIX = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";

/**
 * Resolve the full path to a binary by checking common install locations
 * and then falling back to directories in process.env.PATH.
 */
function resolveBinary(name: string): string {
  // Check well-known locations first (fast, no PATH dependency)
  for (const dir of COMMON_BIN_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  // Walk process.env.PATH
  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  // Fall back to bare name and let execFileSync search PATH
  return name;
}

/**
 * Build an env object that includes a robust PATH so child processes
 * can find binaries even when the daemon was started with a minimal env.
 */
function robustEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(base ?? process.env) };
  const current = env.PATH ?? "";
  const needed = ROBUST_PATH_SUFFIX.split(":");
  const parts = current.split(":");
  for (const dir of needed) {
    if (!parts.includes(dir)) {
      parts.push(dir);
    }
  }
  env.PATH = parts.join(":");
  return env;
}

function buildNavEnv(session: Session): NodeJS.ProcessEnv {
  const env = robustEnv();
  const extra = session.nav_extra ?? {};
  const setEnv = (key: string, value: unknown): void => {
    if (value === undefined || value === null) {
      return;
    }
    const str = String(value);
    if (str.length > 0) {
      env[key] = str;
    }
  };

  setEnv("DOTFILES_TERMINAL", session.terminal);
  setEnv("DOTFILES_NOTIFY_WEZTERM_PANE_ID", extra.wezterm_pane_id);
  setEnv("DOTFILES_NOTIFY_WEZTERM_WINDOW_ID", extra.wezterm_window_id);
  setEnv("DOTFILES_NOTIFY_KITTY_WINDOW_ID", extra.kitty_window_id);
  setEnv("DOTFILES_NOTIFY_ITERM_SESSION_ID", extra.iterm_session_id);
  setEnv("DOTFILES_NOTIFY_TTY", extra.tty);
  setEnv("DOTFILES_NOTIFY_ZELLIJ_PANE_ID", extra.zellij_pane_id);

  return env;
}

function callbackPath(): string {
  return process.env.CLAUDE_NOTIFY_CALLBACK ??
    path.join(os.homedir(), ".config/scripts/claude-notify-callback.sh");
}

function runCallback(session: Session): void {
  const script = callbackPath();
  if (!fs.existsSync(script)) {
    throw new Error(`Missing callback script at ${script}`);
  }
  execFileSync(script, [session.nav_session ?? "", session.nav_tab ?? ""], {
    env: buildNavEnv(session),
    stdio: "ignore",
  });
}

function navigateTmux(session: Session): void {
  const targetSession = session.nav_session ?? undefined;
  if (!targetSession) {
    return;
  }
  const tmux = resolveBinary("tmux");
  const navExtra = session.nav_extra ?? {};
  const windowName = session.nav_tab ?? (navExtra.tmux_window_name as string | undefined);
  const windowId = navExtra.tmux_window_id as string | undefined;
  const paneId = session.nav_pane_id ?? (navExtra.tmux_pane_id as string | undefined);

  try {
    execFileSync(tmux, ["switch-client", "-t", targetSession], { stdio: "ignore" });
  } catch {
    // Ignore tmux errors when no server is running.
  }

  if (windowName || windowId) {
    const target = windowId ? `${targetSession}:${windowId}` : `${targetSession}:${windowName}`;
    try {
      execFileSync(tmux, ["select-window", "-t", target], { stdio: "ignore" });
    } catch {
      // ignore
    }
  }

  if (paneId) {
    try {
      execFileSync(tmux, ["select-pane", "-t", paneId], { stdio: "ignore" });
    } catch {
      // ignore
    }
  }
}

function navigateZellij(session: Session): void {
  if (!session.nav_session || !session.nav_tab) {
    return;
  }
  const zellij = resolveBinary("zellij");
  try {
    execFileSync(
      zellij,
      ["--session", session.nav_session, "action", "go-to-tab-name", session.nav_tab],
      { stdio: "ignore" },
    );
  } catch {
    // ignore
  }

  // Focus specific pane via zj-control plugin (best-effort — stale IDs fail gracefully)
  const paneId = session.nav_pane_id ?? (session.nav_extra?.zellij_pane_id as string | undefined);
  if (paneId) {
    try {
      execFileSync(
        zellij,
        [
          "--session", session.nav_session,
          "pipe", "--plugin", "zj-control", "--name", "focus-pane", "--", paneId,
        ],
        { stdio: "ignore", env: robustEnv() },
      );
    } catch {
      // Stale pane ID or plugin unavailable — tab-level navigation still succeeded
    }
  }
}

export function navigateToSession(session: Session): NavigateResult {
  try {
    runCallback(session);
    if (session.multiplexer === "tmux") {
      navigateTmux(session);
    } else if (session.multiplexer === "zellij") {
      navigateZellij(session);
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Navigation failed";
    return { ok: false, message };
  }
}
