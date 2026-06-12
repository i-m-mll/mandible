import { execFileSync } from "node:child_process";
import type { Db } from "./db.js";
import type { AuthRequest } from "./types.js";

export interface CodexThreadArchiver {
  archive(threadId: string): void;
  unarchive(threadId: string): void;
}

export interface WorkerThreadArchiveCandidate {
  provider_session_id: string;
  console_session_id: string;
  mandible_session_id: string | null;
  issue_id: string;
  work_unit_id: string | null;
}

export class CodexCliThreadArchiver implements CodexThreadArchiver {
  archive(threadId: string): void {
    this.run("archive", threadId);
  }

  unarchive(threadId: string): void {
    this.run("unarchive", threadId);
  }

  private run(action: "archive" | "unarchive", threadId: string): void {
    execFileSync("codex", [action, threadId], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 15_000,
    });
  }
}

export const defaultCodexThreadArchiver = new CodexCliThreadArchiver();

export function safeArchiveCodexThread(
  archiver: CodexThreadArchiver,
  threadId: string,
  log: (message: string) => void = console.warn,
): boolean {
  try {
    archiver.archive(threadId);
    return true;
  } catch (error) {
    log(`[codex-thread-archive] failed to archive ${threadId}: ${errorMessage(error)}`);
    return false;
  }
}

export function safeUnarchiveCodexThread(
  archiver: CodexThreadArchiver,
  threadId: string,
  log: (message: string) => void = console.warn,
): boolean {
  try {
    archiver.unarchive(threadId);
    return true;
  } catch (error) {
    log(`[codex-thread-archive] failed to unarchive ${threadId}: ${errorMessage(error)}`);
    return false;
  }
}

export function listCompletedWorkerThreadArchiveCandidates(
  db: Db,
  request: AuthRequest,
): WorkerThreadArchiveCandidate[] {
  if (!tableExists(db, "console_sessions") || !tableExists(db, "work_units")) {
    return [];
  }

  const issueIds = completedIssueIds(db, request);
  if (issueIds.size === 0) {
    return [];
  }

  const liveParentSessionIds = activeParentRoleSessionIds(db);
  const byProviderId = new Map<string, WorkerThreadArchiveCandidate>();

  for (const row of candidateRowsFromWorkUnits(db, issueIds)) {
    addCandidate(byProviderId, row, liveParentSessionIds);
  }

  if (tableExists(db, "ledger_session_issue_links") || tableExists(db, "session_issues")) {
    for (const row of candidateRowsFromIssueSessions(db, issueIds)) {
      addCandidate(byProviderId, row, liveParentSessionIds);
    }
  }

  return Array.from(byProviderId.values()).sort((a, b) =>
    a.provider_session_id.localeCompare(b.provider_session_id),
  );
}

function addCandidate(
  byProviderId: Map<string, WorkerThreadArchiveCandidate>,
  row: CandidateRow,
  liveParentSessionIds: Set<string>,
): void {
  const providerSessionId = stringOrNull(row.provider_session_id);
  const consoleSessionId = stringOrNull(row.console_session_id);
  if (!providerSessionId || !consoleSessionId) return;
  if (row.command !== "codex") return;
  if (isLiveSessionStatus(row.console_status) || isLiveSessionStatus(row.mandible_status)) return;

  const mandibleSessionId = stringOrNull(row.mandible_session_id);
  if (
    liveParentSessionIds.has(providerSessionId) ||
    liveParentSessionIds.has(consoleSessionId) ||
    (mandibleSessionId != null && liveParentSessionIds.has(mandibleSessionId))
  ) {
    return;
  }

  byProviderId.set(providerSessionId, {
    provider_session_id: providerSessionId,
    console_session_id: consoleSessionId,
    mandible_session_id: mandibleSessionId,
    issue_id: String(row.issue_id),
    work_unit_id: stringOrNull(row.work_unit_id),
  });
}

function completedIssueIds(db: Db, request: AuthRequest): Set<string> {
  const ids = new Set<string>();
  if (tableExists(db, "ledger_auth_issue_links") && tableExists(db, "ledger_issues")) {
    const rows = db.prepare(
      `SELECT DISTINCT i.id
       FROM ledger_auth_issue_links l
       JOIN ledger_issues i ON i.id = l.issue_id
       WHERE l.auth_request_id = ?
         AND l.link_type IN ('resolves', 'fixed_by')
         AND i.status = 'closed'
         AND (i.resolution IS NULL OR i.resolution = 'merged')`,
    ).all(request.id) as Array<{ id: string }>;
    for (const row of rows) {
      ids.add(row.id);
    }
  }

  for (const ref of request.issue_closures ?? request.issues ?? []) {
    ids.add(ref);
  }
  return ids;
}

interface CandidateRow {
  provider_session_id: unknown;
  console_session_id: unknown;
  mandible_session_id: unknown;
  command: unknown;
  console_status: unknown;
  mandible_status: unknown;
  issue_id: unknown;
  work_unit_id: unknown;
}

function candidateRowsFromWorkUnits(db: Db, issueIds: Set<string>): CandidateRow[] {
  const rows: CandidateRow[] = [];
  const workUnitRows = db.prepare(
    `SELECT id, issue_id, ledger_issue_id, assigned_session_id
     FROM work_units
     WHERE state = 'resolved'
       AND assigned_session_id IS NOT NULL`,
  ).all() as Array<{
    id: string;
    issue_id: string;
    ledger_issue_id?: string | null;
    assigned_session_id: string | null;
  }>;

  for (const workUnit of workUnitRows) {
    const issueId = workUnit.ledger_issue_id && issueIds.has(workUnit.ledger_issue_id)
      ? workUnit.ledger_issue_id
      : issueIds.has(workUnit.issue_id)
        ? workUnit.issue_id
        : null;
    if (!issueId || !workUnit.assigned_session_id) continue;

    rows.push(...consoleSessionRowsForLink(db, {
      issueId,
      workUnitId: workUnit.id,
      sessionId: workUnit.assigned_session_id,
    }));
  }
  return rows;
}

function candidateRowsFromIssueSessions(db: Db, issueIds: Set<string>): CandidateRow[] {
  const rows: CandidateRow[] = [];
  const linkedSessions = new Map<string, string>();

  if (tableExists(db, "ledger_session_issue_links")) {
    const linkRows = db.prepare(
      "SELECT session_id, issue_id FROM ledger_session_issue_links",
    ).all() as Array<{ session_id: string; issue_id: string }>;
    for (const row of linkRows) {
      if (issueIds.has(row.issue_id)) linkedSessions.set(row.session_id, row.issue_id);
    }
  }

  if (tableExists(db, "session_issues")) {
    const legacyRows = db.prepare(
      "SELECT session_id, issue_id FROM session_issues",
    ).all() as Array<{ session_id: string; issue_id: string }>;
    for (const row of legacyRows) {
      if (issueIds.has(row.issue_id) && !linkedSessions.has(row.session_id)) {
        linkedSessions.set(row.session_id, row.issue_id);
      }
    }
  }

  for (const [sessionId, issueId] of linkedSessions) {
    rows.push(...consoleSessionRowsForLink(db, {
      issueId,
      workUnitId: null,
      sessionId,
    }));
  }
  return rows;
}

function consoleSessionRowsForLink(
  db: Db,
  input: { issueId: string; workUnitId: string | null; sessionId: string },
): CandidateRow[] {
  return db.prepare(
    `SELECT
       cs.provider_session_id,
       cs.id AS console_session_id,
       cs.mandible_session_id,
       cs.command,
       cs.status AS console_status,
       s.status AS mandible_status,
       ? AS issue_id,
       ? AS work_unit_id
     FROM console_sessions cs
     LEFT JOIN sessions s ON s.id = COALESCE(cs.mandible_session_id, ?)
     WHERE cs.id = ?
        OR cs.mandible_session_id = ?
        OR cs.provider_session_id = ?`,
  ).all(
    input.issueId,
    input.workUnitId,
    input.sessionId,
    input.sessionId,
    input.sessionId,
    input.sessionId,
  ) as CandidateRow[];
}

function activeParentRoleSessionIds(db: Db): Set<string> {
  const ids = new Set<string>();
  if (!tableExists(db, "ledger_issue_checkpoints")) return ids;

  const rows = db.prepare(
    `SELECT payload_json
     FROM ledger_issue_checkpoints
     WHERE kind = 'parent-role'
     ORDER BY created_at DESC`,
  ).all() as Array<{ payload_json: string }>;

  for (const row of rows) {
    const payload = parseJsonObject(row.payload_json);
    const sessionId = typeof payload?.session_id === "string" ? payload.session_id : null;
    if (!sessionId || !isSessionLive(db, sessionId)) continue;
    ids.add(sessionId);
  }
  return ids;
}

function isSessionLive(db: Db, sessionId: string): boolean {
  if (!tableExists(db, "sessions")) return false;
  const row = db.prepare(
    "SELECT status FROM sessions WHERE id = ?",
  ).get(sessionId) as { status?: string | null } | undefined;
  return isLiveSessionStatus(row?.status);
}

function isLiveSessionStatus(value: unknown): boolean {
  return value === "active" || value === "idle" || value === "running";
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function tableExists(db: Db, table: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table);
  return Boolean(row);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
