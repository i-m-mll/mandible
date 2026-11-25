import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Result, WakeEnvironment, WakeExecutor, WakeFailure } from "./types.js";

/**
 * The desktop app reads only the queue of its own bundled CLI. Another CLI
 * (a Homebrew cask, say) prints "Queued message" and exits 0 into a queue the
 * app never reads, so this path is absolute and never looked up on PATH.
 */
export const CODEX_APP_CLI = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
export const CODEX_APP_BUNDLE_ID = "com.openai.codex";
const LSAPPINFO = "/usr/bin/lsappinfo";
const OPEN = "/usr/bin/open";
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Surface = { kind: "app" } | { kind: "other"; detail: string };

/**
 * A thread lives in the desktop app iff the first line of its rollout, its own
 * `session_meta`, has `source: "vscode"`: the thread was started through an
 * app-server, which is how the app (and agent-spawn's short-lived server, whose
 * threads the app resumes) create threads. A terminal thread has `cli`, a
 * `codex exec` thread `exec`, a sub-agent an object. Later `session_meta` lines
 * of a forked sub-agent are its parent's, so only the first line counts.
 */
async function threadSurface(home: string, threadId: string): Promise<Result<Surface, WakeFailure>> {
  const sessions = path.join(home, ".codex", "sessions");
  let entries: string[];
  try {
    entries = await readdir(sessions, { recursive: true });
  } catch (thrown) {
    if ((thrown as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: { kind: "other", detail: `no ${sessions}` } };
    return { ok: false, error: { code: "entry_point_failed", detail: `reading ${sessions}: ${String(thrown)}` } };
  }
  const rollout = entries.find((entry) => entry.endsWith(`-${threadId}.jsonl`));
  if (rollout === undefined) return { ok: true, value: { kind: "other", detail: `no rollout for thread ${threadId} under ${sessions}` } };
  const file = path.join(sessions, rollout);
  let first: string | undefined;
  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) { first = line; break; }
    lines.close();
  } catch (thrown) {
    return { ok: false, error: { code: "entry_point_failed", detail: `reading ${file}: ${String(thrown)}` } };
  }
  let meta: { type?: unknown; payload?: { source?: unknown } };
  try {
    meta = JSON.parse(first ?? "");
  } catch {
    return { ok: true, value: { kind: "other", detail: `${file} does not start with a session_meta line` } };
  }
  if (meta.type !== "session_meta") return { ok: true, value: { kind: "other", detail: `${file} does not start with a session_meta line` } };
  const source = meta.payload?.source;
  if (source === "vscode") return { ok: true, value: { kind: "app" } };
  return { ok: true, value: { kind: "other", detail: `thread source is ${JSON.stringify(source)}, not "vscode"` } };
}

async function appRunning(environment: WakeEnvironment): Promise<Result<boolean, WakeFailure>> {
  const result = await environment.run(LSAPPINFO, ["info", "-only", "pid", "-app", CODEX_APP_BUNDLE_ID], { timeout_ms: 5_000 });
  if (result.code !== 0) return { ok: false, error: { code: "entry_point_failed", detail: `lsappinfo: ${failureText(result)}` } };
  const pid = /\bpid\s*=\s*(\d+)/.exec(result.stdout);
  return { ok: true, value: pid !== null && environment.alive(Number(pid[1])) };
}

function failureText(result: { code: number | null; stdout: string; stderr: string }): string {
  const output = (result.stderr.trim() || result.stdout.trim()) || "no output";
  return result.code === null ? `did not exit normally: ${output}` : `exit ${result.code}: ${output}`;
}

/**
 * Queues the wake sentence on a desktop-app thread with the app's bundled CLI,
 * then opens the app's wake link in the background, which makes the app run
 * the queued input. Never launches the app: a quit app is `provider_not_running`.
 */
export const wakeCodex: WakeExecutor = async (target, environment) => {
  const id = target.session_id;
  if (!THREAD_ID.test(id)) return { ok: false, error: { code: "not_app_thread", detail: `${JSON.stringify(id)} is not a Codex thread id` } };

  const surface = await threadSurface(environment.home, id);
  if (!surface.ok) return surface;
  if (surface.value.kind === "other") return { ok: false, error: { code: "not_app_thread", detail: surface.value.detail } };

  const running = await appRunning(environment);
  if (!running.ok) return running;
  if (!running.value) return { ok: false, error: { code: "provider_not_running", detail: `no running app with bundle id ${CODEX_APP_BUNDLE_ID}` } };

  const queued = await environment.run(CODEX_APP_CLI, ["queue", "--thread", id, "--message", target.text], { timeout_ms: 10_000 });
  if (queued.code !== 0) return { ok: false, error: { code: "entry_point_failed", detail: `codex queue: ${failureText(queued)}` } };

  const opened = await environment.run(OPEN, ["-g", `codex://threads/wake/${id}`], { timeout_ms: 10_000 });
  if (opened.code !== 0) return { ok: false, error: { code: "entry_point_failed", detail: `open codex://threads/wake: ${failureText(opened)}; the wake sentence is queued` } };

  return { ok: true, value: undefined };
};
