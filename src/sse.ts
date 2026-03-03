import type { IncomingMessage, ServerResponse } from "node:http";
import type { SSEEvent, SseEvent, StartupCommitInfo } from "./types.js";
import { getDb } from "./db.js";

interface SseClient {
  res: ServerResponse;
  topics: string[];
}

export class SseManager {
  private clients = new Set<SseClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startupCommit: StartupCommitInfo | null = null;

  /** Start periodic heartbeat comments to keep connections alive. */
  startHeartbeat(intervalMs = 15_000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const comment = `: heartbeat ${Date.now()}\n\n`;
      for (const client of this.clients) {
        try { client.res.write(comment); } catch { /* removed on close */ }
      }
    }, intervalMs);
    // Ensure the timer doesn't prevent process exit
    if (this.heartbeatTimer && typeof this.heartbeatTimer === "object" && "unref" in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }
  }

  addClient(req: IncomingMessage, res: ServerResponse, topics: string[]): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(`: connected\n\n`);

    const client: SseClient = { res, topics };
    this.clients.add(client);
    this.maybeSendReloadEvent(client);

    const remove = () => {
      this.clients.delete(client);
    };

    req.on("close", remove);
    res.on("close", remove);
  }

  setStartupCommit(info: StartupCommitInfo | null): void {
    this.startupCommit = info;
  }

  broadcast(event: SSEEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (client.topics.length > 0 && !matchesTopic(event.type, client.topics)) {
        continue;
      }
      // Guard against the race where the client disconnected between the topic
      // check and the write (the "close" event that removes from this.clients
      // is async, so the client can still be in the set with a dead socket).
      try { client.res.write(payload); } catch { /* removed on close */ }
    }
  }

  closeAll(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients) {
      client.res.destroy();
    }
    this.clients.clear();
  }

  count(): number {
    return this.clients.size;
  }

  private maybeSendReloadEvent(client: SseClient): void {
    const uptime = process.uptime();
    if (uptime >= 60) {
      return;
    }
    if (!this.startupCommit) {
      return;
    }

    // Query recently-completed auth requests (within the daemon uptime window)
    let recentRequests: Array<{ id: string; title: string }> = [];
    const bugRefs: Array<{ repo_id: string; issue_id: string }> = [];
    try {
      const db = getDb();
      const cutoff = Date.now() - 60_000;
      const rows = db.prepare(
        `SELECT id, title, commit_message, repo FROM auth_requests
         WHERE status = 'completed' AND exit_code = 0 AND resolved_at > ?
         ORDER BY resolved_at DESC`
      ).all(cutoff) as Array<{ id: string; title: string; commit_message: string; repo: string | null }>;
      recentRequests = rows.map((r) => ({ id: r.id, title: r.title }));
      for (const row of rows) {
        const msg = row.commit_message || "";
        const match = msg.match(/^Bug:\s+(\S+)/m);
        if (match && row.repo) {
          bugRefs.push({ repo_id: row.repo, issue_id: match[1] });
        }
      }
    } catch {
      // DB not ready yet — proceed without recent requests
    }

    const event: SSEEvent = {
      type: "daemon:reloaded",
      data: {
        commit_hash: this.startupCommit.hash,
        commit_summary: this.startupCommit.summary,
        commit_date: this.startupCommit.date,
        uptime,
        recent_requests: recentRequests,
        bug_refs: bugRefs,
      },
      timestamp: new Date().toISOString()
    };
    try {
      client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      return;
    }
  }
}

function matchesTopic(type: string, topics: string[]): boolean {
  return topics.some((topic) => type.startsWith(topic));
}

// --- Module-level singleton for partition code ---

let _instance: SseManager | null = null;

export function setSseManager(manager: SseManager): void {
  _instance = manager;
}

export function broadcast(eventOrType: string | SseEvent, data?: unknown): void {
  if (!_instance) return;

  let type: string;
  let eventData: unknown;

  if (typeof eventOrType === "string") {
    type = eventOrType;
    eventData = data;
  } else {
    type = eventOrType.type ?? eventOrType.event;
    eventData = eventOrType.data;
  }

  _instance.broadcast({
    type,
    data: eventData,
    timestamp: new Date().toISOString()
  });
}

export type { SseEvent };
