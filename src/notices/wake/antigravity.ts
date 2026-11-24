/**
 * Antigravity wake: `agentapi send-message <conversation> <text>` against the
 * language server that runs the conversation. An App conversation is served by
 * the desktop app's hub, found at wake time from the newest hub file whose pid
 * is alive; a CLI conversation is served by its own `agy` process, whose
 * address and token the session registered from inside itself. The token
 * reaches the child only through its environment.
 */

import fs from "node:fs";
import path from "node:path";

import type { Result, WakeEnvironment, WakeExecutor, WakeFailure } from "./types.js";

export const APP_LANGUAGE_SERVER = "/Applications/Antigravity.app/Contents/Resources/bin/language_server";
const TIMEOUT_MS = 10_000;

interface Hub {
  address: string;
  token: string;
}

export const wakeAntigravity: WakeExecutor = async (target, environment) => {
  const dataDir = path.join(environment.home, ".gemini", "antigravity");
  if (fs.existsSync(path.join(dataDir, "conversations", `${target.session_id}.db`))) {
    const hub = liveHub(path.join(dataDir, "daemon"), environment);
    if (!hub.ok) return hub;
    return sendMessage(APP_LANGUAGE_SERVER, hub.value, target.session_id, target.text, environment);
  }
  if (target.registered?.provider !== "antigravity") return { ok: false, error: { code: "no_route" } };
  const agy = path.join(environment.home, ".local", "bin", "agy");
  return sendMessage(agy, target.registered, target.session_id, target.text, environment);
};

function liveHub(daemonDir: string, environment: WakeEnvironment): Result<Hub, WakeFailure> {
  const candidates = listDir(daemonDir)
    .filter((name) => /^hub_\d+\.json$/.test(name))
    .flatMap((name) => {
      const file = path.join(daemonDir, name);
      const hub = readHub(file);
      return hub && environment.alive(hub.pid) ? [{ ...hub, mtime: fs.statSync(file).mtimeMs }] : [];
    })
    .sort((a, b) => b.mtime - a.mtime);
  const newest = candidates[0];
  if (!newest) {
    return { ok: false, error: { code: "provider_not_running", detail: `no hub file in ${daemonDir} names a live process` } };
  }
  return { ok: true, value: { address: `127.0.0.1:${newest.httpPort}`, token: newest.csrfToken } };
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readHub(file: string): { pid: number; httpPort: number; csrfToken: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const hub = parsed as { pid?: unknown; httpPort?: unknown; csrfToken?: unknown };
  return typeof hub.pid === "number" && typeof hub.httpPort === "number" && typeof hub.csrfToken === "string"
    ? { pid: hub.pid, httpPort: hub.httpPort, csrfToken: hub.csrfToken }
    : null;
}

async function sendMessage(
  binary: string,
  hub: Hub,
  conversation: string,
  text: string,
  environment: WakeEnvironment,
): Promise<Result<void, WakeFailure>> {
  const child = await environment.run(binary, ["agentapi", "send-message", conversation, text], {
    env: { ANTIGRAVITY_LS_ADDRESS: hub.address, ANTIGRAVITY_CSRF_TOKEN: hub.token },
    timeout_ms: TIMEOUT_MS,
  });
  const output = parseOutput(child.stdout);
  if (child.code === 0 && output?.response?.sendMessage) return { ok: true, value: undefined };
  const reported = output?.error ?? (child.stderr.trim() || child.stdout.trim());
  const detail = (child.code === null ? `timed out after ${TIMEOUT_MS} ms` : `exited ${child.code}: ${reported}`)
    .replaceAll(hub.token, "<token>")
    .slice(0, 500);
  // agentapi is a Go gRPC client; a dial to a closed port reports "connect: connection refused".
  if (/connection refused/.test(reported)) return { ok: false, error: { code: "route_refused", detail } };
  return { ok: false, error: { code: "entry_point_failed", detail } };
}

function parseOutput(stdout: string): { response?: { sendMessage?: unknown }; error?: string } | null {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
