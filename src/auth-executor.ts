import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { AuthOutputChunk } from "./types.js";

export interface AuthExecutionResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
  started_at: number;
  finished_at: number;
}

// Maximum time to wait for a single auth command (10 minutes).
// Merges requiring YubiKey touch typically complete in seconds; 10 min
// is generous enough for slow git operations while preventing infinite hangs.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ExecuteAuthCommandOptions {
  request_id: string;
  command: string;
  cwd?: string | null;
  onOutput?: (chunk: AuthOutputChunk) => void;
  now?: () => number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  mandibleArgs?: readonly string[];
}

/**
 * Strip agent-key signing overrides from the environment.
 *
 * When Claude Code is running, CLAUDECODE=1 triggers GIT_CONFIG_COUNT/KEY/VALUE
 * env vars that override git's signing key to the agent key. Auth-merge commands
 * MUST use the user's YubiKey (from git config), so we strip these variables to
 * prevent the agent key from silently signing protected-branch merges.
 */
function cleanEnvForAuth(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned = { ...env };
  delete cleaned.CLAUDECODE;

  // Strip all GIT_CONFIG_COUNT / GIT_CONFIG_KEY_* / GIT_CONFIG_VALUE_* overrides
  delete cleaned.GIT_CONFIG_COUNT;
  for (const key of Object.keys(cleaned)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) {
      delete cleaned[key];
    }
  }

  cleaned.AUTH_MERGE_AUTO_CONFIRM = "1";

  return cleaned;
}

export async function executeAuthCommand(
  options: ExecuteAuthCommandOptions
): Promise<AuthExecutionResult> {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started_at = now();

  return await new Promise<AuthExecutionResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let output = "";
    let settled = false;

    // Bug: 297677f — expose the auth request ID so the merge script can query
    // the API for issues and other request-specific metadata.
    const childEnv = { ...cleanEnvForAuth(process.env), ...(options.env ?? {}) };
    childEnv.MANDIBLE_AUTH_REQUEST_ID = options.request_id;

    const executable = options.mandibleArgs
      ? fileURLToPath(new URL("../bin/mandible", import.meta.url)) : "bash";
    const args = options.mandibleArgs ? [...options.mandibleArgs] : ["-c", options.command];
    const child = spawn(executable, args, {
      cwd: options.cwd ?? undefined,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv
    });

    // Emit a synthetic start line so the UI isn't blank during execution
    options.onOutput?.({
      request_id: options.request_id,
      stream: "stdout",
      text: "Executing merge command…\n",
      timestamp: now()
    });

    // Bug: f690657 — enforce a maximum execution time so stuck merges (e.g.
    // YubiKey not present, git hanging on network) do not block the queue
    // or hold the daemon indefinitely.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5000);
      reject(new Error(`Auth command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const handleChunk = (stream: "stdout" | "stderr", data: Buffer): void => {
      const text = data.toString("utf8");
      if (stream === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      output += text;
      options.onOutput?.({
        request_id: options.request_id,
        stream,
        text,
        timestamp: now()
      });
    };

    child.stdout?.on("data", (data: Buffer) => handleChunk("stdout", data));
    child.stderr?.on("data", (data: Buffer) => handleChunk("stderr", data));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit_code: typeof code === "number" ? code : null,
        signal: signal ?? null,
        stdout,
        stderr,
        output,
        started_at,
        finished_at: now()
      });
    });
  });
}
