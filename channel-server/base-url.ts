// Issue 70dffb8 — one base-URL resolution for the channel server.
//
// client.ts and notifications.ts each used to hardcode
// "http://localhost:19420", so a channel server pointed at a non-default
// daemon (an IAB preview on a free port, `MANDIBLE_PORT`, an explicit
// `MANDIBLE_BASE`) silently talked to the wrong instance. Precedence matches
// the internal transport contract: an explicit HTTP MANDIBLE_BASE wins,
// otherwise the backend listener selected by MANDIBLE_PORT is used.

import { DEFAULT_BACKEND_PORT } from "./canonical-origin.js";

const DEFAULT_PORT = String(DEFAULT_BACKEND_PORT);
const DEFAULT_HOST = "http://127.0.0.1";

/**
 * Resolve the Mandible daemon base URL for HTTP requests.
 *
 * Read per call rather than captured at module load so a test (or a spawner
 * that sets the environment late) sees the current value.
 *
 * `MANDIBLE_BASE` is honored only when it is an http: URL. The SSE bridge in
 * notifications.ts drives `node:http` directly, which rejects any other
 * protocol, and there is no file:// spool transport here. A file://, https:,
 * or malformed base therefore falls back to the port-derived default rather
 * than throwing inside a stdio MCP server.
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MANDIBLE_BASE?.trim();
  if (explicit) {
    try {
      if (new URL(explicit).protocol === "http:") {
        return explicit.replace(/\/+$/, "");
      }
    } catch {
      // Malformed base: fall through to the port-derived default.
    }
  }
  const port = env.MANDIBLE_PORT?.trim() || DEFAULT_PORT;
  return `${DEFAULT_HOST}:${port}`;
}
