import { DOMAIN_EVENTS, parseDomainEvent, type MandibleEventType, type EventPayload } from "./contracts.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SSEEvent, SseEvent, StartupCommitInfo } from "./types.js";
import type { ResolvedClientIdentity } from "./server.js";
import { getDb } from "./db.js";
import { isSpaceEvent, type SpaceEvent } from "./spaces/events.js";

const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;

interface SseClient {
  req: IncomingMessage;
  res: ServerResponse;
  topics: string[];
  identity: ResolvedClientIdentity | null;
  remove: () => void;
  removed: boolean;
}

export class SseManager {
  private clients = new Set<SseClient>();
  private observers = new Set<(type: MandibleEventType) => void>();
  private eventObservers = new Set<(event: SSEEvent) => void>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startupCommit: StartupCommitInfo | null = null;

  /** Start periodic heartbeat comments to keep connections alive. */
  startHeartbeat(intervalMs = 15_000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const comment = `: heartbeat ${Date.now()}\n\n`;
      for (const client of this.clients) {
        this.writeClient(client, comment);
      }
      // Also broadcast a real `heartbeat` data event so unfiltered dashboard
      // clients can measure connection liveness from server heartbeats rather
      // than last-event receipt (the fallback-poll freshness gate). Topic-
      // filtered clients are naturally excluded by matchesTopic and keep the
      // `: heartbeat` comment above as their keep-alive.
      this.broadcast({
        type: DOMAIN_EVENTS.HEARTBEAT,
        data: { timestamp: Date.now() },
        timestamp: new Date().toISOString(),
      });
    }, intervalMs);
    // Ensure the timer doesn't prevent process exit
    if (this.heartbeatTimer && typeof this.heartbeatTimer === "object" && "unref" in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }
  }

  addClient(
    req: IncomingMessage,
    res: ServerResponse,
    topics: string[],
    identity: ResolvedClientIdentity | null = null,
  ): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const client: SseClient = {
      req,
      res,
      topics,
      identity,
      remove: () => this.removeClient(client),
      removed: false,
    };
    this.clients.add(client);

    req.on("close", client.remove);
    res.on("close", client.remove);

    this.writeClient(client, `: connected\n\n`);
    this.maybeSendReloadEvent(client);
  }

  setStartupCommit(info: StartupCommitInfo | null): void {
    this.startupCommit = info;
  }

  broadcast(event: SSEEvent): void {
    const parsed = parseDomainEvent(event);
    if (!parsed.ok) throw new Error(parsed.error);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (client.topics.length > 0 && !matchesTopic(event.type, client.topics)) {
        continue;
      }
      this.writeClient(client, payload);
    }
    for (const observer of this.observers) observer(event.type);
    for (const observer of this.eventObservers) observer(event);
  }

  /** Observe the type of every broadcast event; returns the disposer. */
  observe(observer: (type: MandibleEventType) => void): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  observeEvents(observer: (event: SSEEvent) => void): () => void {
    this.eventObservers.add(observer);
    return () => { this.eventObservers.delete(observer); };
  }

  closeAll(): void {
    this.observers.clear();
    this.eventObservers.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of Array.from(this.clients)) {
      this.removeClient(client);
    }
    this.clients.clear();
  }

  count(): number {
    return this.clients.size;
  }

  /** Identity retention hook for later per-user event scoping. */
  countForUser(userId: string): number {
    let count = 0;
    for (const client of this.clients) {
      if (client.identity?.user_id === userId) count += 1;
    }
    return count;
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
    const issueRefs: Array<{ repo_id: string; issue_id: string }> = [];
    try {
      const db = getDb();
      const cutoff = Date.now() - 60_000;
      const rows = db.prepare(
        `SELECT id, title, repo FROM auth_requests
         WHERE status = 'completed' AND exit_code = 0 AND resolved_at > ?
         ORDER BY resolved_at DESC`
      ).all(cutoff) as Array<{ id: string; title: string; repo: string | null }>;
      recentRequests = rows.map((r) => ({ id: r.id, title: r.title }));
      for (const row of rows) {
        if (!row.repo) continue;
        const links = db.prepare(
          "SELECT issue_id FROM ledger_auth_issue_links WHERE auth_request_id = ?"
        ).all(row.id) as Array<{ issue_id: string }>;
        for (const { issue_id: issueId } of links) {
          issueRefs.push({ repo_id: row.repo, issue_id: issueId });
        }
      }
    } catch {
      // DB not ready yet — proceed without recent requests
    }

    const event: SSEEvent = {
      type: DOMAIN_EVENTS.DAEMON_RELOADED,
      data: {
        commit_hash: this.startupCommit.hash,
        commit_summary: this.startupCommit.summary,
        commit_date: this.startupCommit.date,
        uptime,
        recent_requests: recentRequests,
        issue_refs: issueRefs,
        bug_refs: issueRefs,
      },
      timestamp: new Date().toISOString()
    };
    this.writeClient(client, `data: ${JSON.stringify(event)}\n\n`);
  }

  private writeClient(client: SseClient, payload: string): void {
    if (client.removed) {
      return;
    }
    if (this.isOverBuffered(client)) {
      this.removeClient(client);
      return;
    }
    try {
      const accepted = client.res.write(payload);
      if (!accepted && this.isOverBuffered(client)) {
        this.removeClient(client);
      }
    } catch {
      this.removeClient(client);
    }
  }

  private isOverBuffered(client: SseClient): boolean {
    return client.res.writableLength > MAX_CLIENT_BUFFER_BYTES;
  }

  private removeClient(client: SseClient): void {
    if (client.removed) {
      return;
    }
    client.removed = true;
    client.req.off("close", client.remove);
    client.res.off("close", client.remove);
    this.clients.delete(client);
    try {
      client.res.destroy();
    } catch {
      // Best-effort cleanup for already-closed responses.
    }
  }
}

function matchesTopic(type: string, topics: string[]): boolean {
  return topics.some((topic) => type.startsWith(topic));
}

// --- Module-level singleton for partition code ---

let _instance: SseManager | null = null;

export function setSseManager(manager: SseManager | null): void {
  _instance = manager;
}

export function broadcast<E extends MandibleEventType>(event: E, data: EventPayload<E>): void;
export function broadcast(event: SseEvent): void;
export function broadcast(eventOrType: MandibleEventType | SseEvent, data?: unknown): void {
  if (!_instance) return;

  let type: MandibleEventType;
  let eventData: unknown;

  if (typeof eventOrType === "string") {
    type = eventOrType;
    eventData = data;
  } else {
    type = eventOrType.type ?? eventOrType.event;
    eventData = eventOrType.data;
  }

  const parsed = parseDomainEvent({ type, data: eventData, timestamp: new Date().toISOString() });
  if (!parsed.ok) throw new Error(parsed.error);
  _instance.broadcast(parsed.value as SSEEvent);
}

export function broadcastConsoleTelemetry(data: unknown): void {
  broadcast(DOMAIN_EVENTS.CONSOLE_TELEMETRY, data);
}

/**
 * Broadcast a frozen `space:*` SSE event over the existing {@link broadcast}
 * helper. Space-mutating routes (C2 `src/routes/spaces.ts` and later
 * route-adding children) call this with a value from the shared
 * `SPACE_EVENTS` enum (`src/spaces/events.ts`); C5 owns this single broadcast
 * seam so no per-child SSE plumbing is required.
 *
 * The event name is validated against the frozen enum via {@link isSpaceEvent}
 * so an unregistered ad-hoc string can never leak onto the `space:*` SSE topic.
 * `space:` topic subscribers receive these through the existing prefix-match
 * topic filter in {@link SseManager.broadcast}; there is no new SSE transport.
 */
export function broadcastSpaceEvent(event: SpaceEvent, data?: unknown): void {
  if (!isSpaceEvent(event)) throw new Error(`Unknown Space event: ${event}`);
  broadcast({ event, data } as SseEvent);
}

export type { SseEvent };
