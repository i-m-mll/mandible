import type SqliteDatabase from "./sqlite.js";
import { getDb } from "./db.js";
import { broadcast } from "./sse.js";
import type { ConsoleAttentionState } from "./types.js";

export interface HookAttentionInput {
  sessionRef?: string | null;
  transcriptPath?: string | null;
  message?: string | null;
}

export interface HookAttentionResult {
  ok: boolean;
  status: "raised" | "unknown_session" | "cleared" | "not_set";
  session_id: string | null;
}

type HookAttentionState = ConsoleAttentionState & {
  message: string | null;
  transcript_path: string | null;
  provider_session_id: string | null;
};

interface ResolvedHookSession {
  session_id: string;
  provider_session_id: string | null;
}

const hookAttentionBySession = new Map<string, HookAttentionState>();

export function raiseHookNotificationAttention(input: HookAttentionInput): HookAttentionResult {
  const resolved = resolveHookSession(input);
  if (!resolved) {
    return { ok: true, status: "unknown_session", session_id: null };
  }

  const message = normalizeMessage(input.message);
  const transcriptPath = normalizeText(input.transcriptPath);
  const now = Date.now();
  const state: HookAttentionState = {
    session_id: resolved.session_id,
    kind: "hook_notification",
    source: "claude_hook",
    at: now,
    active: true,
    screen_excerpt: message ?? "Claude notification hook fired",
    clear_conditions: ["transcript_activity", "structured_stream_activity", "manual_clear"],
    detail: {
      provider: "claude",
      confidence: "medium",
      reason: "Claude Code notification hook reported the session needs attention",
      ...(message ? { matched: message } : {}),
    },
    message,
    transcript_path: transcriptPath,
    provider_session_id: resolved.provider_session_id,
  };
  hookAttentionBySession.set(resolved.session_id, state);
  broadcast("console:attention", {
    console_session_id: resolved.session_id,
    session_id: resolved.session_id,
    needs_attention: true,
    attention: state,
  });
  return { ok: true, status: "raised", session_id: resolved.session_id };
}

export function clearHookNotificationAttention(input: HookAttentionInput): HookAttentionResult {
  const resolved = resolveHookSession(input);
  if (!resolved) {
    const transcriptPath = normalizeText(input.transcriptPath);
    if (transcriptPath) {
      for (const [sessionId, state] of hookAttentionBySession) {
        if (state.transcript_path === transcriptPath) {
          hookAttentionBySession.delete(sessionId);
          broadcast("console:attention", {
            console_session_id: sessionId,
            session_id: sessionId,
            needs_attention: false,
            attention: null,
            cleared_kind: "hook_notification",
          });
          return { ok: true, status: "cleared", session_id: sessionId };
        }
      }
    }
    return { ok: true, status: "not_set", session_id: null };
  }

  if (!hookAttentionBySession.has(resolved.session_id)) {
    return { ok: true, status: "not_set", session_id: resolved.session_id };
  }
  hookAttentionBySession.delete(resolved.session_id);
  broadcast("console:attention", {
    console_session_id: resolved.session_id,
    session_id: resolved.session_id,
    needs_attention: false,
    attention: null,
    cleared_kind: "hook_notification",
  });
  return { ok: true, status: "cleared", session_id: resolved.session_id };
}

export function getHookNotificationAttention(sessionId: string): HookAttentionState | null {
  return hookAttentionBySession.get(sessionId) ?? null;
}

export function resetHookNotificationAttentionForTests(): void {
  hookAttentionBySession.clear();
}

function resolveHookSession(input: HookAttentionInput): ResolvedHookSession | null {
  const sessionRef = normalizeText(input.sessionRef);
  const transcriptPath = normalizeText(input.transcriptPath);
  if (!sessionRef && !transcriptPath) {
    return null;
  }
  try {
    const db = getDb() as SqliteDatabase;
    return (
      findConsoleSession(db, sessionRef, transcriptPath) ??
      findRegistrySession(db, sessionRef, transcriptPath)
    );
  } catch {
    return null;
  }
}

function findConsoleSession(
  db: SqliteDatabase,
  sessionRef: string | null,
  transcriptPath: string | null,
): ResolvedHookSession | null {
  if (sessionRef) {
    const row = db.prepare(`
      SELECT id, provider_session_id
      FROM console_sessions
      WHERE id = ? OR provider_session_id = ? OR mandible_session_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(sessionRef, sessionRef, sessionRef) as { id: string; provider_session_id: string | null } | undefined;
    if (row) {
      return { session_id: row.id, provider_session_id: row.provider_session_id ?? null };
    }
  }

  if (transcriptPath) {
    const row = db.prepare(`
      SELECT cs.id, cs.provider_session_id
      FROM conversations c
      JOIN console_sessions cs
        ON cs.provider_session_id = c.session_id
        OR cs.id = c.session_id
        OR cs.mandible_session_id = c.session_id
      WHERE c.source_path = ?
      ORDER BY cs.updated_at DESC
      LIMIT 1
    `).get(transcriptPath) as { id: string; provider_session_id: string | null } | undefined;
    if (row) {
      return { session_id: row.id, provider_session_id: row.provider_session_id ?? null };
    }
  }
  return null;
}

function findRegistrySession(
  db: SqliteDatabase,
  sessionRef: string | null,
  transcriptPath: string | null,
): ResolvedHookSession | null {
  if (sessionRef) {
    const row = db.prepare(`
      SELECT id
      FROM sessions
      WHERE id = ? OR conversation_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(sessionRef, sessionRef) as { id: string } | undefined;
    if (row) {
      return { session_id: row.id, provider_session_id: sessionRef };
    }
  }

  if (transcriptPath) {
    const row = db.prepare(`
      SELECT s.id, c.session_id AS provider_session_id
      FROM conversations c
      JOIN sessions s ON s.id = c.session_id OR s.conversation_id = c.session_id
      WHERE c.source_path = ?
      ORDER BY s.updated_at DESC
      LIMIT 1
    `).get(transcriptPath) as { id: string; provider_session_id: string | null } | undefined;
    if (row) {
      return { session_id: row.id, provider_session_id: row.provider_session_id ?? null };
    }
  }
  return null;
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 2048) : null;
}

function normalizeMessage(value: string | null | undefined): string | null {
  return normalizeText(value)?.slice(0, 500) ?? null;
}
