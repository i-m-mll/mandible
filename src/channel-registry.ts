import { DOMAIN_EVENTS } from "./contracts.js";
// Bug: 0b454df — Channel session registry: tracks which sessions are
// connected via the MCP channel server. Channel sessions are "1.5-class"
// citizens — richer than third-class (external/discovered) but without the
// full lifecycle control of first-class (SDK) sessions. They register via
// the channel server's tool calls and receive webhooks/inbox items through
// MCP notifications.
//
// Liveness is based on last_tool_call freshness rather than PID, since
// channel sessions run in a separate process that Mandible doesn't own.

import { EventEmitter } from "node:events";
import { getDb } from "./db.js";
import {
  parseSessionIdentityMismatch,
  type SessionIdentityMismatch,
} from "./identity/session-mismatch.js";
import { broadcast } from "./sse.js";

// Bug: 7ab2f3e — Channel event types emitted by ChannelRegistry for bridging
// into PTYBackend's stream.
export type ChannelEventType = "connect" | "tool_call" | "notification" | "disconnect";

export interface ChannelEvent {
  event_type: ChannelEventType;
  session_id: string;
  timestamp: number;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  notification_type?: string;
  notification_content?: string;
}

/** In-memory representation of a channel-connected session. */
export interface ChannelSession {
  session_id: string;
  connected_at: number;
  last_tool_call: number;
  tools_called: string[];
  cwd: string | null;
  branch: string | null;
}

/** Staleness threshold: sessions with no tool call for this long are stale. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory registry of channel-connected sessions. The canonical session
 * data lives in the sessions table (registered via POST /api/sessions/register);
 * this registry is a lightweight overlay tracking channel-specific metadata
 * (tool call recency, which tools have been used).
 */
class ChannelRegistry extends EventEmitter {
  private sessions = new Map<string, ChannelSession>();

  constructor() {
    super();
  }

  /**
   * Register or update a channel session. Called on first tool invocation
   * from the MCP channel server.
   */
  register(sessionId: string, cwd: string | null, branch: string | null): ChannelSession {
    const now = Date.now();
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.last_tool_call = now;
      existing.cwd = cwd ?? existing.cwd;
      existing.branch = branch ?? existing.branch;
      return existing;
    }

    const session: ChannelSession = {
      session_id: sessionId,
      connected_at: now,
      last_tool_call: now,
      tools_called: [],
      cwd,
      branch,
    };
    this.sessions.set(sessionId, session);

    // Also mark the session in the DB with channel_connected_at
    try {
      const db = getDb();
      db.prepare(
        `UPDATE sessions SET channel_connected_at = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(now, sessionId);
    } catch {
      // Best effort — the sessions row may not exist yet
    }

    broadcast(DOMAIN_EVENTS.CHANNEL_SESSION_CONNECTED, {
      session_id: sessionId,
      connected_at: now,
      cwd,
      branch,
    });

    // Bug: 7ab2f3e — Emit typed event for channel event bridge
    const connectEvent: ChannelEvent = {
      event_type: "connect",
      session_id: sessionId,
      timestamp: now,
    };
    this.emit("channel_event", connectEvent);

    return session;
  }

  /**
   * Record a tool call for a channel session. Updates last_tool_call and
   * adds the tool name to the set of tools called.
   */
  /**
   * Record a tool call for a channel session. Updates last_tool_call and
   * adds the tool name to the set of tools called.
   *
   * Bug: 7ab2f3e — Extended with optional input/output for event bridge.
   */
  recordToolCall(
    sessionId: string,
    toolName: string,
    toolInput?: unknown,
    toolOutput?: unknown,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.last_tool_call = Date.now();
    if (!session.tools_called.includes(toolName)) {
      session.tools_called.push(toolName);
    }

    // Update channel_last_tool_call in DB for persistence across daemon restarts
    try {
      const db = getDb();
      db.prepare(
        `UPDATE sessions SET channel_last_tool_call = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(session.last_tool_call, sessionId);
    } catch {
      // Best effort
    }

    // Bug: 7ab2f3e — Emit typed event for channel event bridge
    const toolEvent: ChannelEvent = {
      event_type: "tool_call",
      session_id: sessionId,
      timestamp: session.last_tool_call,
      tool_name: toolName,
      tool_input: toolInput,
      tool_output: toolOutput,
    };
    this.emit("channel_event", toolEvent);
  }

  /**
   * Record a notification sent to a channel session.
   * Bug: 7ab2f3e — Emits a channel_event for the event bridge.
   */
  recordNotification(
    sessionId: string,
    notificationType: string,
    notificationContent?: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const notifEvent: ChannelEvent = {
      event_type: "notification",
      session_id: sessionId,
      timestamp: Date.now(),
      notification_type: notificationType,
      notification_content: notificationContent,
    };
    this.emit("channel_event", notifEvent);
  }

  /** Disconnect a channel session (e.g., on MCP server shutdown). */
  disconnect(sessionId: string): void {
    // Bug: 7ab2f3e — Emit disconnect event before removing from map
    const disconnectEvent: ChannelEvent = {
      event_type: "disconnect",
      session_id: sessionId,
      timestamp: Date.now(),
    };
    this.emit("channel_event", disconnectEvent);

    this.sessions.delete(sessionId);
    broadcast(DOMAIN_EVENTS.CHANNEL_SESSION_DISCONNECTED, { session_id: sessionId });
  }

  /** Get a specific channel session, or null if not connected. */
  get(sessionId: string): ChannelSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Check if a session is channel-connected (in-memory check). */
  isChannelConnected(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Check if a channel session is alive based on tool call recency.
   * Returns true if the session has called a tool within the staleness window.
   */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return (Date.now() - session.last_tool_call) < STALE_THRESHOLD_MS;
  }

  /** Return all channel-connected sessions (including stale). */
  getAll(): ChannelSession[] {
    return Array.from(this.sessions.values());
  }

  /** Return only alive (non-stale) channel sessions. */
  getAlive(): ChannelSession[] {
    return this.getAll().filter((s) => (Date.now() - s.last_tool_call) < STALE_THRESHOLD_MS);
  }

  /**
   * Return channel sessions on a given branch (alive only).
   * Used by webhook routing to find channel sessions that can receive events.
   */
  getByBranch(branch: string): ChannelSession[] {
    return this.getAlive().filter((s) => s.branch === branch);
  }

  /**
   * Prune stale sessions from the in-memory registry.
   * Called periodically by the daemon.
   */
  pruneStale(): string[] {
    const pruned: string[] = [];
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.last_tool_call > STALE_THRESHOLD_MS * 2) {
        this.sessions.delete(id);
        pruned.push(id);
      }
    }
    return pruned;
  }
}

// Singleton instance — used by routes and the daemon
let _instance: ChannelRegistry | null = null;

export function getChannelRegistry(): ChannelRegistry {
  if (!_instance) {
    _instance = new ChannelRegistry();
  }
  return _instance;
}

/**
 * Check whether a session is channel-connected using the DB column as fallback.
 * Useful when the in-memory registry may not have the session (e.g., after
 * daemon restart) but the DB column persists the state.
 */
export function isChannelConnectedInDb(sessionId: string): boolean {
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT channel_connected_at FROM sessions WHERE id = ? AND channel_connected_at IS NOT NULL`
      )
      .get(sessionId) as { channel_connected_at: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Get all channel-connected sessions from the DB (persisted state).
 * Used by the API endpoint GET /api/sessions/channel-connected.
 */
export function getChannelConnectedSessionsFromDb(): Array<{
  id: string;
  app: string;
  status: string;
  branch: string | null;
  cwd: string | null;
  channel_connected_at: number;
  channel_last_tool_call: number | null;
  // Issue 499c148 — client-token vs session-binding user disagreement.
  identity_mismatch: SessionIdentityMismatch | null;
}> {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, app, status, branch, cwd, channel_connected_at, channel_last_tool_call,
                identity_mismatch_at, identity_mismatch_json
         FROM sessions
         WHERE channel_connected_at IS NOT NULL
         ORDER BY channel_last_tool_call DESC NULLS LAST, channel_connected_at DESC`
      )
      .all() as Array<{
        id: string;
        app: string;
        status: string;
        branch: string | null;
        cwd: string | null;
        channel_connected_at: number;
        channel_last_tool_call: number | null;
        identity_mismatch_at: number | null;
        identity_mismatch_json: string | null;
      }>;
    return rows.map(({ identity_mismatch_at, identity_mismatch_json, ...row }) => ({
      ...row,
      identity_mismatch: parseSessionIdentityMismatch(
        identity_mismatch_at,
        identity_mismatch_json,
      ),
    }));
  } catch {
    return [];
  }
}
