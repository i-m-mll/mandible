import { buildAuthChannelEvent } from "./events.js";
import type { UndeliveredAuthResult } from "./types.js";
export async function runStartupCatchUp(args: {
  sessionId: string;
  conversationId?: string | null;
  mcpServer: { notification(notification: { method: string; params: { content: string; meta?: Record<string, string> } }): Promise<void> };
  fetchUndelivered: (sessionId: string, conversationId?: string | null) => Promise<UndeliveredAuthResult[]>;
  markDelivered: (requestId: string) => Promise<void>;
  log: (line: string) => void;
}): Promise<void> {
  const { sessionId, conversationId, mcpServer, fetchUndelivered, markDelivered, log } = args;
  let rows: UndeliveredAuthResult[];
  try {
    rows = await fetchUndelivered(sessionId, conversationId);
  } catch (err) {
    log(`Warning: channel-server startup catch-up fetch failed: ${err}\n`);
    return;
  }
  if (rows.length === 0) return;

  log(`channel-server startup catch-up: replaying ${rows.length} undelivered auth result(s)\n`);
  for (const row of rows) {
    const payload = buildAuthChannelEvent({
      request_id: row.id,
      status: row.status,
      head_branch: row.head_branch,
      title: row.title,
      exit_code: row.exit_code,
      // resolved_at omitted from the formatter's input — meta carries enough
      // for the agent to ground itself; the timestamp is implicit.
    });
    try { await mcpServer.notification({ method: "notifications/claude/channel", params: { ...payload } }); }
    catch (error) { log(`Warning: auth notification failed: ${String(error)}\n`); continue; }
    try {
      await markDelivered(row.id);
    } catch (err) {
      log(`Warning: failed to mark auth_request ${row.id} delivered: ${err}\n`);
      // Continue: the row will resurface on the next session start (still
      // tier 1 until the project grace window elapses).
    }
  }
}
