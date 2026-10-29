import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ProcessGroupSupervisor } from "../scripts/process-group-supervisor.mjs";

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

/** A rejected command whose signing environment may still be in use. */
export class AuthCommandCleanupError extends Error {
  readonly processGroupSettled = false;
}

export async function executeAuthCommand(
  options: ExecuteAuthCommandOptions
): Promise<AuthExecutionResult> {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started_at = now();
  let stdout = "";
  let stderr = "";
  let output = "";
  let failure: unknown;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const supervisor = new ProcessGroupSupervisor({ graceMs: 1500, handleSignals: false });

  const childEnv = { ...cleanEnvForAuth(process.env), ...(options.env ?? {}) };
  childEnv.MANDIBLE_AUTH_REQUEST_ID = options.request_id;
  const executable = options.mandibleArgs
    ? fileURLToPath(new URL("../bin/mandible", import.meta.url)) : "bash";
  const args = options.mandibleArgs ? [...options.mandibleArgs] : ["-c", options.command];
  const child = spawn(executable, args, {
    cwd: options.cwd ?? undefined,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
    detached: true,
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  if (child.pid) supervisor.attach(child);
  // Install exit/error observation before any user output callback can fail.
  const settled = supervisor.settle(child).then(
    result => ({ ok: true as const, result }),
    error => ({ ok: false as const, error }),
  );
  const fail = (error: unknown): void => {
    if (!failed) { failed = true; failure = error; }
    // settle() joins this same cleanup promise and reports any failure.
    void supervisor.stopActive().catch(() => {});
  };
  const emit = (stream: "stdout" | "stderr", text: string): void => {
    if (failed) return;
    try {
      options.onOutput?.({ request_id: options.request_id, stream, text, timestamp: now() });
    } catch (error) { fail(error); }
  };
  const collect = (stream: "stdout" | "stderr", data: Buffer): void => {
    const text = data.toString("utf8");
    if (stream === "stdout") stdout += text;
    else stderr += text;
    output += text;
    emit(stream, text);
  };
  child.stdout.on("data", (data: Buffer) => collect("stdout", data));
  child.stderr.on("data", (data: Buffer) => collect("stderr", data));
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);

  try {
    timer = setTimeout(() => fail(new Error(`Auth command timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    emit("stdout", "Executing merge command…\n");
    const outcome = await settled;
    clearTimeout(timer);
    if (!outcome.ok) {
      // An unsuccessful spawn has no process group to retain.
      if (child.pid) throw new AuthCommandCleanupError("Auth command process group could not be cleaned up.", {
        cause: failed ? new AggregateError([failure, outcome.error], "Auth command failed and cleanup was not verified.") : outcome.error,
      });
      throw outcome.error;
    }
    await closed;
    if (failed) throw failure;
    return {
      exit_code: outcome.result.code,
      signal: outcome.result.signal,
      stdout, stderr, output, started_at, finished_at: now(),
    };
  } finally {
    clearTimeout(timer);
    await supervisor.close();
  }
}
