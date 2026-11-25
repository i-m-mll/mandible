import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WakeExecutor } from "./types.js";

export const REFUSED_EXIT = 3;
const POST_TIMEOUT_MS = 5_000;

/** The poster beside this module, `.ts` in a source checkout and `.js` when built. */
export function claudePosterPath(): string {
  const extension = path.extname(fileURLToPath(import.meta.url));
  return fileURLToPath(new URL(`./claude-poster${extension}`, import.meta.url));
}

/** The auth line and the user line, as the inbox socket reads them. */
export function claudeInboxLines(token: string, text: string): string {
  return `${JSON.stringify({ type: "auth", token })}\n${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/**
 * Starts a turn on an idle Claude Code session by posting to its inbox socket.
 *
 * The daemon never posts itself: on macOS Claude Code consults the token only
 * once the posting process has exited, so a short-lived child posts and exits,
 * and the daemon reaps it. The token reaches the child on stdin only.
 */
export const wakeClaude: WakeExecutor = async (target, environment) => {
  const route = target.registered;
  if (route?.provider !== "claude") return { ok: false, error: { code: "no_route" } };
  const scrub = (text: string) => text.split(route.token).join("[token]").trim();
  const result = await environment.run(process.execPath, ["--no-install", claudePosterPath(), route.socket], {
    stdin: claudeInboxLines(route.token, target.text),
    timeout_ms: POST_TIMEOUT_MS,
  });
  if (result.code === 0) return { ok: true, value: undefined };
  const detail = scrub(result.stderr) || (result.code === null ? `poster did not exit within ${POST_TIMEOUT_MS} ms` : `poster exited ${result.code}`);
  if (result.code === REFUSED_EXIT) return { ok: false, error: { code: "route_refused", detail } };
  return { ok: false, error: { code: "entry_point_failed", detail } };
};
