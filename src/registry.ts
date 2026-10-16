import { DOMAIN_EVENTS } from "./contracts.js";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "./sqlite.js";
import { broadcast } from "./sse.js";
import { AttributionReadResolver } from "./identity/read-projection.js";
import { parseSessionIdentityMismatch } from "./identity/session-mismatch.js";
import { resolveSessionOwnerUserId } from "./session-ownership.js";
import type { Logger, NavMetadataStatus, Session, SessionStatus } from "./types.js";

// Bug: 568eca7 — pinned-panes.tsv location for reaper backward compat
const PINNED_PANES_TSV = path.join(os.homedir(), ".cache", "claude-reaper", "pinned-panes.tsv");



let psSupported: boolean | null = null;
const CURRENT_PROCESS_PID_START = normalizePidStart(
  new Date(Date.now() - process.uptime() * 1000).toISOString(),
);

// Batched liveness (issue 21502ff): a short-lived cache of pid → start time so a
// sessions-list request runs at most one `ps` spawn for all active pids instead
// of one per session. The reaper independently rechecks liveness every 60 s, so
// a modest TTL here is safe; `isPidAlive` (process.kill(pid, 0)) is still checked
// per session in real time, so a stale cache cannot resurrect a truly dead pid.
interface PidStartCacheEntry {
  value: string | null;
  at: number;
}
const pidStartCache = new Map<number, PidStartCacheEntry>();
const PID_START_CACHE_TTL_MS = 30_000;

function getCachedPidStart(pid: number): string | null | undefined {
  const entry = pidStartCache.get(pid);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.at > PID_START_CACHE_TTL_MS) {
    pidStartCache.delete(pid);
    return undefined;
  }
  return entry.value;
}

function setCachedPidStart(pid: number, value: string | null): void {
  pidStartCache.set(pid, { value, at: Date.now() });
}

/** Reuse observed process evidence without issuing per-PID subprocesses. */
export function cachePidStartTimes(evidence: ReadonlyMap<number, string>): void {
  for (const [pid, start] of evidence) {
    if (Number.isInteger(pid) && pid > 0) setCachedPidStart(pid, normalizePidStart(start));
  }
}

/**
 * Warm the pid-start cache for many pids using a single `ps` invocation.
 * Pids not reported by `ps` are treated as gone and cached as null. Best-effort:
 * on failure the cache is left untouched and callers fall back to per-pid reads.
 */
export function primePidStartTimes(pids: number[]): void {
  if (!canUsePs()) {
    return;
  }
  const unique = Array.from(new Set(pids)).filter(
    (pid) =>
      Number.isInteger(pid) &&
      pid > 0 &&
      pid !== process.pid &&
      getCachedPidStart(pid) === undefined,
  );
  if (unique.length === 0) {
    return;
  }
  try {
    const output = execSync(`ps -p ${unique.join(",")} -o pid=,lstart=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const seen = new Set<number>();
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const match = trimmed.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      setCachedPidStart(pid, normalizePidStart(match[2].trim()));
      seen.add(pid);
    }
    for (const pid of unique) {
      if (!seen.has(pid)) {
        setCachedPidStart(pid, null);
      }
    }
  } catch {
    // Best-effort: leave the cache untouched; per-session reads still work.
  }
}

export interface SessionInput {
  id: string;
  app: string;
  pid?: number | null;
  pid_start?: string | null;
  cwd?: string | null;
  branch?: string | null;
  worktree?: string | null;
  terminal?: string | null;
  multiplexer?: string | null;
  nav_session?: string | null;
  nav_tab?: string | null;
  nav_pane_id?: string | null;
  nav_extra?: Record<string, unknown> | null;
  task?: string | null;
  status?: SessionStatus;
  parent_id?: string | null;
  agent_type?: string | null;
  description?: string | null;
  // Bug: 6d7411b — conversation_id persists across Claude Code resumes
  conversation_id?: string | null;
}

export interface NavMetadataUpdate {
  nav_tab?: string | null;
  nav_metadata_status: NavMetadataStatus;
  nav_metadata_attempts: number;
  nav_metadata_last_error?: string | null;
  nav_metadata_last_attempt_at?: string | null;
  nav_metadata_next_retry_at?: string | null;
}

export interface SessionUpdate {
  task?: string | null;
  status?: SessionStatus;
  continuation?: string | null;
  pinned?: number | null;
}

export interface ChildSessionInput {
  id?: string;
  app?: string;
  agent_type?: string | null;
  description?: string | null;
  status?: SessionStatus;
}

export interface SessionListOptions {
  status?: SessionStatus;
  app?: string;
  parent_id?: string | null;
  // Pagination + scoping (issue 21502ff). `scope: "all"` returns full history
  // (no default limit) and is the explicit opt-in that keeps deep history and
  // direct lookups reachable. Otherwise the result is bounded to `limit` newest
  // sessions with a stable keyset `cursor`.
  scope?: "all";
  limit?: number;
  cursor?: string | null;
}

export interface SessionPage {
  sessions: Session[];
  total: number;
  returned: number;
  nextCursor: string | null;
  scope: "all" | "default";
  limit: number | null;
}

export const DEFAULT_SESSIONS_PAGE_LIMIT = 100;
export const MAX_SESSIONS_PAGE_LIMIT = 500;

function encodeSessionCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\u0000${id}`, "utf8").toString("base64url");
}

function decodeSessionCursor(
  cursor: string,
): { created_at: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = raw.indexOf("\u0000");
    if (idx < 0) {
      return null;
    }
    return { created_at: raw.slice(0, idx), id: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

interface SessionRow {
  id: string;
  app: string;
  pid: number | null;
  pid_start: string | null;
  cwd: string | null;
  branch: string | null;
  worktree: string | null;
  terminal: string | null;
  multiplexer: string | null;
  nav_session: string | null;
  nav_tab: string | null;
  nav_pane_id: string | null;
  nav_extra: string | null;
  nav_metadata_status: NavMetadataStatus | null;
  nav_metadata_attempts: number | null;
  nav_metadata_last_error: string | null;
  nav_metadata_last_attempt_at: string | null;
  nav_metadata_next_retry_at: string | null;
  task: string | null;
  status: SessionStatus;
  parent_id: string | null;
  agent_type: string | null;
  pinned: number | null;
  continuation: string | null;
  continuation_acked_by: string | null;
  description: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  // Bug: e01653d — real user activity time from JSONL transcript mtime
  last_active: string | null;
  // Bug: 0b454df — channel-connected session tracking
  channel_connected_at: number | null;
  channel_last_tool_call: number | null;
  owner_user_id: string | null;
  // Issue 499c148 — client-token vs session-binding user disagreement.
  identity_mismatch_at: number | null;
  identity_mismatch_json: string | null;
}

// Issue e726bfe — this is a fresh-database bootstrap, not a migration path.
// Migrations in src/db-migrations.ts (plus the db-baseline snapshot) are the
// only thing that upgrades an existing database; this statement exists solely
// so an isolated caller with an empty SQLite handle (unit tests) gets the
// current schema in one shot. It must therefore stay column- and
// index-complete against the migrated schema, and it must never contain
// ALTER TABLE. If a new sessions column is needed, add a migration and mirror
// the column here.
const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  pid INTEGER,
  pid_start TEXT,
  cwd TEXT,
  branch TEXT,
  worktree TEXT,
  terminal TEXT,
  multiplexer TEXT,
  nav_session TEXT,
  nav_tab TEXT,
  nav_pane_id TEXT,
  nav_extra TEXT,
  nav_metadata_status TEXT NOT NULL DEFAULT 'not_applicable',
  nav_metadata_attempts INTEGER NOT NULL DEFAULT 0,
  nav_metadata_last_error TEXT,
  nav_metadata_last_attempt_at TEXT,
  nav_metadata_next_retry_at TEXT,
  task TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  parent_id TEXT,
  agent_type TEXT,
  description TEXT,
  conversation_id TEXT,
  pinned INTEGER DEFAULT 0,
  continuation TEXT,
  continuation_acked_by TEXT,
  last_active TEXT,
  channel_connected_at INTEGER,
  channel_last_tool_call INTEGER,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  identity_mismatch_at INTEGER,
  identity_mismatch_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  FOREIGN KEY(parent_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions(parent_id);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
CREATE INDEX IF NOT EXISTS sessions_app_idx ON sessions(app);
CREATE INDEX IF NOT EXISTS sessions_nav_metadata_idx
  ON sessions(nav_metadata_status, nav_metadata_next_retry_at);
CREATE INDEX IF NOT EXISTS sessions_branch_idx ON sessions(branch) WHERE branch IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_channel_idx
  ON sessions(channel_connected_at) WHERE channel_connected_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_conversation_id
  ON sessions(conversation_id) WHERE conversation_id IS NOT NULL;
`;

/**
 * Create the sessions schema on an empty database. Existing databases are
 * upgraded by the migration chain only (issue e726bfe): this function must
 * stay a pure CREATE ... IF NOT EXISTS bootstrap and never repair or alter a
 * table it did not just create.
 */
export function ensureSessionSchema(db: SqliteDatabase): void {
  db.exec(SESSION_SCHEMA);
}

function safeJsonParse(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function normalizePidStart(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return trimmed;
  }
  return parsed.toISOString();
}

export function readPidStartTime(pid: number): string | null {
  if (pid === process.pid) {
    return CURRENT_PROCESS_PID_START;
  }
  const cached = getCachedPidStart(pid);
  if (cached !== undefined) {
    return cached;
  }
  if (!canUsePs()) {
    return null;
  }
  try {
    const output = execSync(`ps -p ${pid} -o lstart=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (output) {
      const value = normalizePidStart(output);
      setCachedPidStart(pid, value);
      return value;
    }
    const fallback = execSync(`ps -o lstart= -p ${pid}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const value = normalizePidStart(fallback);
    setCachedPidStart(pid, value);
    return value;
  } catch {
    return null;
  }
}

function canUsePs(): boolean {
  if (psSupported !== null) {
    return psSupported;
  }
  try {
    execSync("ps -p 1 -o lstart=", { stdio: "ignore" });
    psSupported = true;
  } catch {
    psSupported = false;
  }
  return psSupported;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

export function checkLiveness(session: Session): "alive" | "dead" {
  if (session.status !== "active") {
    return "dead";
  }

  // Bug: 0b454df — channel-connected sessions: liveness is based on tool call
  // freshness rather than PID, since the MCP channel server runs in a separate
  // process that Mandible doesn't own. If channel_connected_at is set but there
  // is no PID, use channel_last_tool_call for staleness.
  if (session.channel_connected_at && !session.pid) {
    const lastToolCall = session.channel_last_tool_call ?? session.channel_connected_at;
    const CHANNEL_STALE_MS = 5 * 60 * 1000; // 5 minutes
    return (Date.now() - lastToolCall) < CHANNEL_STALE_MS ? "alive" : "dead";
  }

  if (!session.pid) {
    const updatedAt = new Date(session.updated_at).getTime();
    const ageMs = Date.now() - updatedAt;
    const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
    return ageMs > STALE_THRESHOLD_MS ? "dead" : "alive";
  }
  if (!isPidAlive(session.pid)) {
    return "dead";
  }
  if (session.pid_start) {
    const expected = normalizePidStart(session.pid_start);
    const current = readPidStartTime(session.pid);
    if (expected && current && expected !== current) {
      return "dead";
    }
  }
  return "alive";
}

function normalizeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

type NavMetadataState = {
  navTab: string | null;
  status: NavMetadataStatus;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
};

function computeNavMetadataState(
  input: SessionInput,
  existing: Session | null
): NavMetadataState {
  const multiplexer = normalizeText(input.multiplexer);
  const navSessionInput = normalizeText(input.nav_session);
  const navPaneInput = normalizeText(input.nav_pane_id);
  const navTabInput = normalizeText(input.nav_tab);
  const existingStatus = existing?.nav_metadata_status ?? "not_applicable";
  const existingAttempts = existing?.nav_metadata_attempts ?? 0;
  const existingLastError = existing?.nav_metadata_last_error ?? null;
  const existingLastAttemptAt = existing?.nav_metadata_last_attempt_at ?? null;
  const existingNextRetryAt = existing?.nav_metadata_next_retry_at ?? null;

  if (multiplexer !== "zellij") {
    return {
      navTab: null,
      status: "not_applicable",
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      nextRetryAt: null,
    };
  }

  if (navTabInput) {
    return {
      navTab: navTabInput,
      status: "ready",
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      nextRetryAt: null,
    };
  }

  const existingNavSession = existing?.nav_session ?? null;
  const existingNavPane = existing?.nav_pane_id ?? null;
  const navTargetChanged = existing
    ? normalizeText(existingNavSession) !== navSessionInput ||
      normalizeText(existingNavPane) !== navPaneInput
    : false;
  const keepResolvedTab = Boolean(existing?.nav_tab) && !navTargetChanged;

  if (keepResolvedTab) {
    return {
      navTab: existing?.nav_tab ?? null,
      status: "ready",
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      nextRetryAt: null,
    };
  }

  const preservedStatus: NavMetadataStatus = navTargetChanged
    ? "pending"
    : (existingStatus === "pending" ||
       existingStatus === "degraded" ||
       existingStatus === "failed")
      ? existingStatus
      : "pending";

  return {
    navTab: null,
    status: preservedStatus,
    attempts: navTargetChanged ? 0 : existingAttempts,
    lastError: navTargetChanged ? null : existingLastError,
    lastAttemptAt: navTargetChanged ? null : existingLastAttemptAt,
    nextRetryAt: navTargetChanged ? null : existingNextRetryAt,
  };
}

function toSession(row: SessionRow, attributionResolver: AttributionReadResolver): Session {
  return {
    id: row.id,
    app: row.app,
    pid: row.pid ?? null,
    pid_start: row.pid_start ?? null,
    cwd: row.cwd ?? null,
    branch: row.branch ?? null,
    worktree: row.worktree ?? null,
    terminal: row.terminal ?? null,
    multiplexer: row.multiplexer ?? null,
    nav_session: row.nav_session ?? null,
    nav_tab: row.nav_tab ?? null,
    nav_pane_id: row.nav_pane_id ?? null,
    nav_extra: safeJsonParse(row.nav_extra),
    nav_metadata_status: row.nav_metadata_status ?? "not_applicable",
    nav_metadata_attempts: row.nav_metadata_attempts ?? 0,
    nav_metadata_last_error: row.nav_metadata_last_error ?? null,
    nav_metadata_last_attempt_at: row.nav_metadata_last_attempt_at ?? null,
    nav_metadata_next_retry_at: row.nav_metadata_next_retry_at ?? null,
    task: row.task ?? null,
    status: row.status,
    parent_id: row.parent_id ?? null,
    agent_type: row.agent_type ?? null,
    pinned: row.pinned ?? 0,
    continuation: row.continuation ?? null,
    continuation_acked_by: row.continuation_acked_by ?? null,
    description: row.description ?? null,
    conversation_id: row.conversation_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ended_at: row.ended_at ?? null,
    // Bug: e01653d — real user activity time from JSONL transcript mtime
    last_active: row.last_active ?? null,
    // Bug: 0b454df — channel-connected session tracking
    channel_connected_at: row.channel_connected_at ?? null,
    channel_last_tool_call: row.channel_last_tool_call ?? null,
    owner_user_id: row.owner_user_id ?? null,
    owner: attributionResolver.user(row.owner_user_id),
    // Issue 499c148 — null unless a registration saw the client token and the
    // session bindings resolve to different users.
    identity_mismatch: parseSessionIdentityMismatch(
      row.identity_mismatch_at,
      row.identity_mismatch_json,
    ),
  };
}

/**
 * Check if a pane ID is in the pinned-panes.tsv file.
 * Format: tab-separated lines: scope\thost\tpane_id\tcontext\ttimestamp
 * Bug: 568eca7 — one-way import from reaper's pinned-panes.tsv on session registration
 */
function isPaneIdPinned(paneId: string): boolean {
  try {
    if (!fs.existsSync(PINNED_PANES_TSV)) {
      return false;
    }
    const content = fs.readFileSync(PINNED_PANES_TSV, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const fields = line.split("\t");
      // pane_id is the 3rd column (index 2)
      if (fields.length >= 3 && fields[2] === paneId) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Write or remove an entry in pinned-panes.tsv for backward compat with the reaper.
 * Bug: 568eca7
 */
export function syncPinnedPanesTsv(paneId: string, pinned: boolean): void {
  try {
    const dir = path.dirname(PINNED_PANES_TSV);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (pinned) {
      // Append if not already present
      if (!isPaneIdPinned(paneId)) {
        const timestamp = new Date().toISOString();
        const line = `all\t\t${paneId}\t\t${timestamp}\n`;
        fs.appendFileSync(PINNED_PANES_TSV, line, "utf8");
      }
    } else {
      // Remove entries matching this pane ID
      if (!fs.existsSync(PINNED_PANES_TSV)) return;
      const content = fs.readFileSync(PINNED_PANES_TSV, "utf8");
      const lines = content.split("\n").filter((line) => {
        if (!line.trim()) return false;
        const fields = line.split("\t");
        return !(fields.length >= 3 && fields[2] === paneId);
      });
      fs.writeFileSync(PINNED_PANES_TSV, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
    }
  } catch {
    // Non-critical — log silently fails are OK
  }
}

export class SessionRegistry {
  private db: SqliteDatabase;
  private logger: Logger;

  constructor(db: SqliteDatabase, logger: Logger = () => undefined) {
    this.db = db;
    this.logger = logger;
    ensureSessionSchema(db);
  }

  registerSession(input: SessionInput): Session {
    const now = new Date().toISOString();
    const pidStart = normalizePidStart(input.pid_start);
    const status = input.status ?? "active";
    const existingRow = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(input.id) as SessionRow | undefined;
    const existing = existingRow
      ? toSession(existingRow, new AttributionReadResolver(this.db))
      : null;
    const pick = (incoming: string | null | undefined, previous: string | null): string | null => {
      if (incoming === undefined) {
        return previous;
      }
      return normalizeText(incoming);
    };

    const multiplexer = pick(input.multiplexer, existing?.multiplexer ?? null);
    const navSession = pick(input.nav_session, existing?.nav_session ?? null);
    const navPaneId = pick(input.nav_pane_id, existing?.nav_pane_id ?? null);
    const navState = computeNavMetadataState(
      {
        ...input,
        multiplexer,
        nav_session: navSession,
        nav_pane_id: navPaneId,
      },
      existing,
    );
    const navExtra = input.nav_extra ? JSON.stringify(input.nav_extra) : existingRow?.nav_extra ?? null;

    if (existingRow) {
      // Issue f52d4dd — a re-registration restates only the facts its caller
      // knows. An omitted field keeps the stored value and an explicit null
      // clears it, matching the nav fields above. The MCP channel server
      // re-registers a session its launcher already registered and never knows
      // the launcher's pid or terminal; replacing them with null erased them.
      const stated = <K extends keyof SessionInput & keyof SessionRow>(key: K): SessionRow[K] =>
        input[key] === undefined ? existingRow[key] : (input[key] ?? null) as SessionRow[K];
      // pid and pid_start identify one process together, so they move as a pair.
      const pidStated = input.pid !== undefined || input.pid_start !== undefined;
      this.db
        .prepare(
          `UPDATE sessions SET
            app = ?,
            pid = ?,
            pid_start = ?,
            cwd = ?,
            branch = ?,
            worktree = ?,
            terminal = ?,
            multiplexer = ?,
            nav_session = ?,
            nav_tab = ?,
            nav_pane_id = ?,
            nav_extra = ?,
            nav_metadata_status = ?,
            nav_metadata_attempts = ?,
            nav_metadata_last_error = ?,
            nav_metadata_last_attempt_at = ?,
            nav_metadata_next_retry_at = ?,
            task = COALESCE(?, task),
            status = ?,
            parent_id = ?,
            agent_type = ?,
            description = ?,
            conversation_id = COALESCE(?, conversation_id),
            updated_at = ?,
            ended_at = ?
          WHERE id = ?
          `,
        )
        .run(
          input.app,
          pidStated ? input.pid ?? null : existingRow.pid,
          pidStated ? pidStart : existingRow.pid_start,
          stated("cwd"),
          stated("branch"),
          stated("worktree"),
          stated("terminal"),
          multiplexer,
          navSession,
          navState.navTab,
          navPaneId,
          navExtra,
          navState.status,
          navState.attempts,
          navState.lastError,
          navState.lastAttemptAt,
          navState.nextRetryAt,
          input.task ?? null,
          status,
          stated("parent_id"),
          stated("agent_type"),
          stated("description"),
          input.conversation_id ?? null,
          now,
          status === "active" ? null : now,
          input.id,
        );
      const session = this.getSession(input.id);
      if (session) {
        broadcast(DOMAIN_EVENTS.SESSION_UPDATED, session);
        return session;
      }
    }

    const ownerUserId = resolveSessionOwnerUserId(
      this.db,
      { app_names: [input.app, input.agent_type] },
      this.logger,
      { source: "session_registry", entity_id: input.id },
    );

    this.db
      .prepare(
        `INSERT INTO sessions (
          id, app, pid, pid_start, cwd, branch, worktree, terminal, multiplexer,
          nav_session, nav_tab, nav_pane_id, nav_extra, nav_metadata_status,
          nav_metadata_attempts, nav_metadata_last_error, nav_metadata_last_attempt_at,
          nav_metadata_next_retry_at, task, status, parent_id,
          agent_type, description, conversation_id, created_at, updated_at, ended_at,
          owner_user_id
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`,
      )
      .run(
        input.id,
        input.app,
        input.pid ?? null,
        pidStart,
        input.cwd ?? null,
        input.branch ?? null,
        input.worktree ?? null,
        input.terminal ?? null,
        multiplexer,
        navSession,
        navState.navTab,
        navPaneId,
        navExtra,
        navState.status,
        navState.attempts,
        navState.lastError,
        navState.lastAttemptAt,
        navState.nextRetryAt,
        input.task ?? null,
        status,
        input.parent_id ?? null,
        input.agent_type ?? null,
        input.description ?? null,
        input.conversation_id ?? null,
        now,
        now,
        status === "active" ? null : now,
        ownerUserId,
      );

    const session = this.getSession(input.id);
    if (!session) {
      throw new Error("Failed to register session");
    }

    // Bug: 568eca7 — one-way import: if pane ID is in pinned-panes.tsv, mark session as pinned
    if (navPaneId && isPaneIdPinned(navPaneId) && !session.pinned) {
      this.db
        .prepare("UPDATE sessions SET pinned = 1 WHERE id = ?")
        .run(session.id);
      session.pinned = 1;
    }

    broadcast(DOMAIN_EVENTS.SESSION_REGISTERED, session);
    return session;
  }

  updateSession(id: string, update: SessionUpdate): Session | null {
    const session = this.getSession(id);
    if (!session) {
      return null;
    }
    const now = new Date().toISOString();
    const status = update.status ?? session.status;
    const endedAt = status === "active" ? null : session.ended_at ?? now;

    // Bug: 568eca7 — include pinned in updateSession
    const pinned = update.pinned !== undefined && update.pinned !== null
      ? update.pinned
      : null;

    this.db
      .prepare(
        `UPDATE sessions SET
          task = COALESCE(?, task),
          continuation = COALESCE(?, continuation),
          pinned = COALESCE(?, pinned),
          status = ?,
          updated_at = ?,
          ended_at = ?
        WHERE id = ?`,
      )
      .run(update.task ?? null, update.continuation ?? null, pinned, status, now, endedAt, id);

    const updated = this.getSession(id);
    if (updated) {
      if (status === "ended" || status === "dead") {
        // Bug: cbbb3d9 — transfer continuation to work unit on session end
        this.transferContinuationToWorkUnit(updated);
        broadcast(DOMAIN_EVENTS.SESSION_ENDED, updated);
      } else {
        broadcast(DOMAIN_EVENTS.SESSION_UPDATED, updated);
      }
    }
    return updated;
  }

  endSession(id: string, status: SessionStatus = "ended"): Session | null {
    return this.updateSession(id, { status });
  }

  registerChildSession(parentId: string, input: ChildSessionInput): Session | null {
    const parent = this.getSession(parentId);
    if (!parent) {
      return null;
    }
    const childId = input.id ?? crypto.randomUUID();
    const child = this.registerSession({
      id: childId,
      app: input.app ?? parent.app,
      parent_id: parentId,
      agent_type: input.agent_type ?? null,
      description: input.description ?? null,
      task: input.description ?? null,
      status: input.status ?? "active",
    });
    broadcast(DOMAIN_EVENTS.SESSION_CHILD_ADDED, { parent_id: parentId, child });
    return child;
  }

  updateChildStatus(parentId: string, childId: string, status: SessionStatus): Session | null {
    const child = this.getSession(childId);
    if (!child || child.parent_id !== parentId) {
      return null;
    }
    const updated = this.updateSession(childId, { status });
    if (updated && (status === "ended" || status === "dead")) {
      broadcast(DOMAIN_EVENTS.SESSION_CHILD_ENDED, { parent_id: parentId, child: updated });
    }
    return updated;
  }

  private buildSessionFilter(options: SessionListOptions): {
    clauses: string[];
    params: Array<string | null>;
  } {
    const clauses: string[] = [];
    const params: Array<string | null> = [];

    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.app) {
      clauses.push("app = ?");
      params.push(options.app);
    }
    if (options.parent_id !== undefined) {
      if (options.parent_id === null) {
        clauses.push("parent_id IS NULL");
      } else {
        clauses.push("parent_id = ?");
        params.push(options.parent_id);
      }
    }
    return { clauses, params };
  }

  // Map rows to sessions with liveness derived from a single batched `ps` spawn
  // for all active pids, rather than one spawn per session (issue 21502ff).
  private mapWithLiveness(rows: SessionRow[]): Session[] {
    // One attribution resolver per batch (main's user-attribution read path),
    // consistent with the single batched liveness spawn (issue 21502ff).
    const attributionResolver = new AttributionReadResolver(this.db);
    const sessions = rows.map((row) => toSession(row, attributionResolver));
    const pids = sessions
      .filter((s) => s.status === "active" && s.pid && s.pid_start)
      .map((s) => s.pid as number);
    if (pids.length > 1) {
      primePidStartTimes(pids);
    }
    return sessions.map((session) => this.ensureLiveness(session));
  }

  listSessions(options: SessionListOptions = {}): Session[] {
    const { clauses, params } = this.buildSessionFilter(options);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC`)
      .all(...params) as SessionRow[];

    return this.mapWithLiveness(rows);
  }

  /**
   * Paginated, bounded-by-default sessions listing (issue 21502ff).
   *
   * The default scope returns the newest `limit` sessions with a stable keyset
   * cursor and an unfiltered `total`, so the common poll returns a small payload
   * while `total` keeps historical sessions visibly present (not deleted).
   * `scope: "all"` returns the full filtered history for explicit history access;
   * direct-id lookups (getSession) are unaffected, so deep links keep working.
   */
  listSessionsPage(options: SessionListOptions = {}): SessionPage {
    const { clauses: filterClauses, params: filterParams } =
      this.buildSessionFilter(options);
    const filterWhere = filterClauses.length
      ? `WHERE ${filterClauses.join(" AND ")}`
      : "";

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM sessions ${filterWhere}`)
        .get(...filterParams) as { n: number }
    ).n;

    const full = options.scope === "all";
    const limit = full
      ? null
      : Math.min(
          Math.max(1, Math.floor(options.limit ?? DEFAULT_SESSIONS_PAGE_LIMIT)),
          MAX_SESSIONS_PAGE_LIMIT,
        );

    const clauses = [...filterClauses];
    const params = [...filterParams];
    if (limit !== null && options.cursor) {
      const cursor = decodeSessionCursor(options.cursor);
      if (cursor) {
        clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(cursor.created_at, cursor.created_at, cursor.id);
      }
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitSql = limit !== null ? `LIMIT ${limit + 1}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ${where} ORDER BY created_at DESC, id DESC ${limitSql}`,
      )
      .all(...params) as SessionRow[];

    let pageRows = rows;
    let nextCursor: string | null = null;
    if (limit !== null && rows.length > limit) {
      pageRows = rows.slice(0, limit);
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeSessionCursor(last.created_at, last.id);
    }

    const sessions = this.mapWithLiveness(pageRows);
    return {
      sessions,
      total,
      returned: sessions.length,
      nextCursor,
      scope: full ? "all" : "default",
      limit,
    };
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    if (!row) {
      return null;
    }
    return this.ensureLiveness(toSession(row, new AttributionReadResolver(this.db)));
  }

  getSessionByPid(pid: number): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE pid = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(pid) as SessionRow | undefined;
    if (!row) {
      return null;
    }
    return this.ensureLiveness(toSession(row, new AttributionReadResolver(this.db)));
  }

  listSessionsNeedingNavMetadata(limit = 50): Session[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE status = 'active'
           AND multiplexer = 'zellij'
           AND nav_metadata_status IN ('pending', 'degraded', 'failed')
           AND (nav_metadata_next_retry_at IS NULL OR nav_metadata_next_retry_at <= ?)
         ORDER BY
           CASE WHEN nav_metadata_next_retry_at IS NULL THEN 0 ELSE 1 END,
           nav_metadata_next_retry_at ASC,
           updated_at ASC
         LIMIT ?`,
      )
      .all(now, Math.max(1, limit)) as SessionRow[];
    const attributionResolver = new AttributionReadResolver(this.db);
    return rows.map((row) => this.ensureLiveness(toSession(row, attributionResolver)));
  }

  updateSessionNavMetadata(id: string, update: NavMetadataUpdate): Session | null {
    const session = this.getSession(id);
    if (!session) {
      return null;
    }
    const now = new Date().toISOString();
    const navTab = update.nav_tab === undefined ? session.nav_tab : normalizeText(update.nav_tab);

    this.db
      .prepare(
        `UPDATE sessions SET
          nav_tab = ?,
          nav_metadata_status = ?,
          nav_metadata_attempts = ?,
          nav_metadata_last_error = ?,
          nav_metadata_last_attempt_at = ?,
          nav_metadata_next_retry_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        navTab,
        update.nav_metadata_status,
        update.nav_metadata_attempts,
        normalizeText(update.nav_metadata_last_error),
        normalizeText(update.nav_metadata_last_attempt_at),
        normalizeText(update.nav_metadata_next_retry_at),
        now,
        id,
      );

    const updated = this.getSession(id);
    if (updated) {
      broadcast(DOMAIN_EVENTS.SESSION_UPDATED, updated);
      if (
        (updated.nav_metadata_status === "degraded" || updated.nav_metadata_status === "failed") &&
        updated.nav_metadata_status !== session.nav_metadata_status
      ) {
        broadcast(DOMAIN_EVENTS.SESSION_METADATA_WARNING, {
          session_id: updated.id,
          nav_metadata_status: updated.nav_metadata_status,
          nav_metadata_last_error: updated.nav_metadata_last_error,
          nav_metadata_attempts: updated.nav_metadata_attempts,
        });
      }
    }
    return updated;
  }

  getSessionTree(id: string): Session | null {
    const rows = this.db
      .prepare("SELECT * FROM sessions")
      .all() as SessionRow[];
    const attributionResolver = new AttributionReadResolver(this.db);
    const sessions = rows.map((row) => this.ensureLiveness(toSession(row, attributionResolver)));
    const byId = new Map<string, Session>();
    const children = new Map<string | null, Session[]>();

    for (const session of sessions) {
      byId.set(session.id, session);
      const key = session.parent_id ?? null;
      if (!children.has(key)) {
        children.set(key, []);
      }
      children.get(key)?.push(session);
    }

    const attach = (session: Session): Session => {
      const childList = children.get(session.id) ?? [];
      session.children = childList.map((child) => attach({ ...child }));
      return session;
    };

    const root = byId.get(id);
    return root ? attach({ ...root }) : null;
  }

  /**
   * Return IDs of all pinned sessions (lightweight, for reaper consumption).
   * Bug: 568eca7
   */
  getPinnedSessionIds(): string[] {
    const rows = this.db
      .prepare("SELECT id FROM sessions WHERE pinned = 1")
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  // Bug: 81c9d85 — update last_active timestamp on activity events
  updateLastActive(sessionId: string, timestamp?: number): void {
    const ts = timestamp
      ? new Date(timestamp).toISOString()
      : new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET last_active = ?, updated_at = ? WHERE id = ?")
      .run(ts, ts, sessionId);
  }

  // Bug: 81c9d85 — transition session to idle when SDK prompt queue drains
  setIdle(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session || session.status !== "active") {
      return;
    }
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?")
      .run(now, sessionId);
    const updated = this.getSession(sessionId);
    if (updated) {
      broadcast(DOMAIN_EVENTS.SESSION_UPDATED, updated);
    }
  }

  // Bug: 81c9d85 — transition session to active (from idle or other non-terminal state)
  setActive(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session || session.status === "active") {
      return;
    }
    // Don't resurrect ended/dead sessions
    if (session.status === "ended" || session.status === "dead") {
      return;
    }
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET status = 'active', updated_at = ? WHERE id = ?")
      .run(now, sessionId);
    const updated = this.getSession(sessionId);
    if (updated) {
      broadcast(DOMAIN_EVENTS.SESSION_UPDATED, updated);
    }
  }

  killSession(id: string): boolean {
    const session = this.getSession(id);
    if (!session || !session.pid) {
      return false;
    }
    try {
      process.kill(session.pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Transfer a session's continuation to linked work units when the session ends.
   * Bug: cbbb3d9 — session-to-work-unit continuation transfer
   */
  private transferContinuationToWorkUnit(session: Session): void {
    if (!session.continuation) {
      return;
    }
    try {
      // Find issues linked to this session
      const links = this.db
        .prepare(
          "SELECT issue_id, repo_id FROM session_issues WHERE session_id = ?"
        )
        .all(session.id) as Array<{ issue_id: string; repo_id: string }>;

      if (links.length === 0) {
        return;
      }

      const now = Date.now();
      for (const link of links) {
        // Find open/committed work unit for this issue+repo
        const wu = this.db
          .prepare(
            `SELECT id FROM work_units
             WHERE issue_id = ? AND repo_id = ? AND state IN ('open', 'committed')
             ORDER BY created_at DESC LIMIT 1`
          )
          .get(link.issue_id, link.repo_id) as { id: string } | undefined;

        if (wu) {
          this.db
            .prepare(
              `UPDATE work_units SET continuation = ?, continuation_by = ?, continuation_at = ?
               WHERE id = ? AND (continuation_at IS NULL OR continuation_at < ?)`
            )
            .run(session.continuation, session.id, now, wu.id, now);
        }
      }
    } catch {
      // Non-critical — best effort transfer
    }
  }

  private ensureLiveness(session: Session): Session {
    if (session.status !== "active") {
      return session;
    }
    const status = checkLiveness(session);
    if (status === "alive") {
      return session;
    }
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run("dead", now, now, session.id);
    const updated = { ...session, status: "dead" as SessionStatus, ended_at: now, updated_at: now };
    // Bug: cbbb3d9 — transfer continuation to work unit on session death
    this.transferContinuationToWorkUnit(updated);
    broadcast(DOMAIN_EVENTS.SESSION_ENDED, updated);
    return updated;
  }
}
