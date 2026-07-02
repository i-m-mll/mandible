import fs from "node:fs";
import type { Db } from "./db.js";
import type { AgenticBackend } from "./agentic-backend.js";
import type {
  ConversationAttachState,
  ConversationSource,
} from "./contracts.js";
import type {
  ConsoleSession,
} from "./types.js";

const RECENT_TRANSCRIPT_MS = 120_000;
const CHANNEL_FRESH_MS = 5 * 60_000;
const LIVE_SESSION_STATUSES = new Set(["active", "idle"]);

export interface ConversationAttachRow {
  id: string;
  source: string;
  source_path: string | null;
  source_mtime: number | null;
  session_id: string | null;
  parent_conversation_id: string | null;
}

export interface ConversationAttachOptions {
  now?: number;
  transcriptFreshMs?: number;
  channelFreshMs?: number;
}

type SessionManagerLike = {
  getAll(): AgenticBackend[];
};

type ExternalSessionRow = {
  id: string;
  status: string | null;
  channel_last_tool_call: number | null;
  channel_connected_at: number | null;
};

function isConversationSource(value: string): value is ConversationSource {
  return value === "claude_code" || value === "codex" || value === "gemini";
}

function supportsResume(source: string, sessionId: string | null): boolean {
  if (!sessionId) return false;
  if (!isConversationSource(source)) return false;
  return source === "claude_code" || source === "codex" || source === "gemini";
}

function supportsFork(source: string): boolean {
  return source === "claude_code";
}

function getOwnedSession(
  sessionManager: SessionManagerLike | undefined,
  providerSessionId: string,
): ConsoleSession | null {
  const sessions = sessionManager?.getAll() ?? [];
  for (const backend of sessions) {
    const meta = backend.meta;
    if (
      (meta.provider_session_id === providerSessionId || meta.id === providerSessionId)
      && meta.status !== "stopped"
      && meta.status !== "crashed"
    ) {
      return meta;
    }
  }
  return null;
}

function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function getExternalSession(db: Db, providerSessionId: string): ExternalSessionRow | null {
  if (!tableExists(db, "sessions")) return null;
  return db
    .prepare(
      `SELECT id, status, channel_last_tool_call, channel_connected_at
         FROM sessions
        WHERE id = ?
           OR conversation_id = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get(providerSessionId, providerSessionId) as ExternalSessionRow | undefined ?? null;
}

function readTranscriptMtime(row: ConversationAttachRow): number | null {
  if (row.source_path) {
    try {
      return fs.statSync(row.source_path).mtimeMs;
    } catch {
      // Fall back to the indexed mtime below.
    }
  }
  return typeof row.source_mtime === "number" && Number.isFinite(row.source_mtime)
    ? row.source_mtime
    : null;
}

export function deriveConversationAttachState(
  row: ConversationAttachRow,
  db: Db,
  sessionManager?: SessionManagerLike,
  options: ConversationAttachOptions = {},
): ConversationAttachState {
  const now = options.now ?? Date.now();
  const transcriptFreshMs = options.transcriptFreshMs ?? RECENT_TRANSCRIPT_MS;
  const channelFreshMs = options.channelFreshMs ?? CHANNEL_FRESH_MS;
  const providerSessionId = row.session_id ?? null;
  const canFork = supportsFork(row.source);
  const base = {
    provider_session_id: providerSessionId,
    can_fork: canFork,
    checked_at: now,
  };

  if (row.parent_conversation_id) {
    return {
      kind: "historical",
      reason: "subagent",
      resumable: false,
      ...base,
    };
  }

  if (!providerSessionId) {
    return {
      kind: "historical",
      reason: "no-session",
      resumable: false,
      ...base,
    };
  }

  const owned = getOwnedSession(sessionManager, providerSessionId);
  if (owned) {
    return {
      kind: "live-owned",
      reason: "mandible-owned",
      resumable: true,
      console_session_id: owned.id,
      ...base,
    };
  }

  const external = getExternalSession(db, providerSessionId);
  if (external && LIVE_SESSION_STATUSES.has(String(external.status))) {
    return {
      kind: "live-external",
      reason: "session-active",
      resumable: false,
      external_session_id: external.id,
      ...base,
    };
  }

  const lastChannelSignal = Math.max(
    Number(external?.channel_last_tool_call ?? 0),
    Number(external?.channel_connected_at ?? 0),
  );
  if (lastChannelSignal > 0 && now - lastChannelSignal <= channelFreshMs) {
    return {
      kind: "live-external",
      reason: "channel-fresh",
      resumable: false,
      external_session_id: external?.id ?? providerSessionId,
      ...base,
    };
  }

  const sourceMtime = readTranscriptMtime(row);
  if (sourceMtime !== null && now - sourceMtime <= transcriptFreshMs) {
    return {
      kind: "live-external",
      reason: "transcript-recent",
      resumable: false,
      source_mtime: sourceMtime,
      ...base,
    };
  }

  if (!supportsResume(row.source, providerSessionId)) {
    return {
      kind: "historical",
      reason: "unsupported-provider",
      resumable: false,
      source_mtime: sourceMtime,
      ...base,
    };
  }

  return {
    kind: "resumable",
    reason: "provider-resumable",
    resumable: true,
    source_mtime: sourceMtime,
    ...base,
  };
}
