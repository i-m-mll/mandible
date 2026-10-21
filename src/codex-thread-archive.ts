import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { isLiveSessionStatus, isSessionAliasLive } from "./session-liveness.js";
import type { AuthRequest } from "./types.js";

// Issue 75f52ac — archiving spawns the codex CLI (up to 15 s). Running it via
// promisified execFile instead of execFileSync keeps the daemon event loop free
// while Stage 3 finalizers run in the background queue.
const execFileAsync = promisify(execFile);

export interface CodexThreadArchiver {
  archive(threadId: string): Promise<void>;
  unarchive(threadId: string): Promise<void>;
}

export interface WorkerThreadArchiveCandidate {
  provider_session_id: string;
  console_session_id: string | null;
  mandible_session_id: string | null;
  issue_id: string;
  work_unit_id: string | null;
}

type CodexCommandRunner = typeof execFileAsync;
type CodexThreadArchiveCommand = "archive" | "unarchive";

interface RankedArchiveCandidate extends WorkerThreadArchiveCandidate {
  rank: number;
}

export class CodexCliThreadArchiver implements CodexThreadArchiver {
  constructor(private readonly execFile: CodexCommandRunner = execFileAsync) {}

  async archive(threadId: string): Promise<void> {
    await this.run("archive", threadId);
  }

  async unarchive(threadId: string): Promise<void> {
    await this.run("unarchive", threadId);
  }

  private async run(command: CodexThreadArchiveCommand, threadId: string): Promise<void> {
    await this.execFile("codex", [command, threadId], {
      timeout: 15_000,
    });
  }
}

export const defaultCodexThreadArchiver = new CodexCliThreadArchiver();

export async function safeArchiveCodexThread(
  archiver: CodexThreadArchiver,
  threadId: string,
  log: (message: string) => void = console.warn,
): Promise<boolean> {
  try {
    await archiver.archive(threadId);
    return true;
  } catch (error) {
    log(`[codex-thread-archive] failed to archive ${threadId}: ${errorMessage(error)}`);
    return false;
  }
}

export async function safeUnarchiveCodexThread(
  archiver: CodexThreadArchiver,
  threadId: string,
  log: (message: string) => void = console.warn,
): Promise<boolean> {
  try {
    await archiver.unarchive(threadId);
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
  if (!tableExists(db, "work_units")) {
    return [];
  }

  const parentRoleSessionIds = allParentRoleSessionIds(db);
  const byProviderId = new Map<string, RankedArchiveCandidate>();
  const closureIssueIds = completedIssueIds(db, request);

  for (const row of directCandidateRowsFromRequestWorkUnits(db, request.id)) {
    addDirectWorkUnitCandidate(db, byProviderId, row, parentRoleSessionIds);
  }

  for (const row of candidateRowsFromRequestWorkUnits(db, request.id)) {
    addCandidate(byProviderId, row, parentRoleSessionIds);
  }

  if (closureIssueIds.size > 0) {
    if (tableExists(db, "console_sessions") && tableExists(db, "ledger_session_issue_links")) {
      for (const row of candidateRowsFromIssueSessionLinks(db, closureIssueIds)) {
        addCandidate(byProviderId, row, parentRoleSessionIds);
      }
    }
  }

  return selectConservativeArchiveCandidates(Array.from(byProviderId.values()), closureIssueIds);
}

function addDirectWorkUnitCandidate(
  db: Db,
  byProviderId: Map<string, RankedArchiveCandidate>,
  row: DirectWorkUnitCandidateRow,
  parentRoleSessionIds: Set<string>,
): void {
  const providerSessionId = stringOrNull(row.worker_provider_session_id);
  if (!providerSessionId) return;
  if (parentRoleSessionIds.has(providerSessionId) || isSessionAliasLive(db, providerSessionId)) return;

  addRankedCandidate(byProviderId, {
    provider_session_id: providerSessionId,
    console_session_id: null,
    mandible_session_id: null,
    issue_id: String(row.issue_id),
    work_unit_id: String(row.work_unit_id),
    rank: 10,
  });
}

function addCandidate(
  byProviderId: Map<string, RankedArchiveCandidate>,
  row: CandidateRow,
  parentRoleSessionIds: Set<string>,
): void {
  const providerSessionId = stringOrNull(row.provider_session_id);
  const consoleSessionId = stringOrNull(row.console_session_id);
  if (!providerSessionId || !consoleSessionId) return;
  if (row.command !== "codex") return;
  if (isLiveSessionStatus(row.console_status) || isLiveSessionStatus(row.mandible_status)) return;

  const mandibleSessionId = stringOrNull(row.mandible_session_id);
  if (
    parentRoleSessionIds.has(providerSessionId) ||
    parentRoleSessionIds.has(consoleSessionId) ||
    (mandibleSessionId != null && parentRoleSessionIds.has(mandibleSessionId))
  ) {
    return;
  }

  addRankedCandidate(byProviderId, {
    provider_session_id: providerSessionId,
    console_session_id: consoleSessionId,
    mandible_session_id: mandibleSessionId,
    issue_id: String(row.issue_id),
    work_unit_id: stringOrNull(row.work_unit_id),
    rank: 0,
  });
}

function addRankedCandidate(
  byProviderId: Map<string, RankedArchiveCandidate>,
  candidate: RankedArchiveCandidate,
): void {
  const existing = byProviderId.get(candidate.provider_session_id);
  if (!existing || compareRankedArchiveCandidates(candidate, existing) < 0) {
    byProviderId.set(candidate.provider_session_id, candidate);
  }
}

function selectConservativeArchiveCandidates(
  candidates: RankedArchiveCandidate[],
  closureIssueIds: Set<string>,
): WorkerThreadArchiveCandidate[] {
  const byClosureIssue = new Map<string, RankedArchiveCandidate>();
  const selected: RankedArchiveCandidate[] = [];

  for (const candidate of candidates) {
    if (!closureIssueIds.has(candidate.issue_id)) {
      selected.push(candidate);
      continue;
    }
    const existing = byClosureIssue.get(candidate.issue_id);
    if (!existing || compareRankedArchiveCandidates(candidate, existing) < 0) {
      byClosureIssue.set(candidate.issue_id, candidate);
    }
  }

  selected.push(...byClosureIssue.values());
  return selected
    .sort((a, b) => a.provider_session_id.localeCompare(b.provider_session_id))
    .map(({ rank: _rank, ...candidate }) => candidate);
}

function compareRankedArchiveCandidates(
  a: RankedArchiveCandidate,
  b: RankedArchiveCandidate,
): number {
  return (
    a.rank - b.rank ||
    String(a.work_unit_id ?? "").localeCompare(String(b.work_unit_id ?? "")) ||
    a.provider_session_id.localeCompare(b.provider_session_id)
  );
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
         AND i.resolution = 'delivered'`,
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

interface DirectWorkUnitCandidateRow {
  worker_provider_session_id: string | null;
  issue_id: string;
  work_unit_id: string;
}

function directCandidateRowsFromRequestWorkUnits(db: Db, requestId: string): DirectWorkUnitCandidateRow[] {
  if (
    !tableHasColumn(db, "work_units", "auth_request_id")
    || !tableHasColumn(db, "work_units", "worker_provider_session_id")
  ) {
    return [];
  }
  return db.prepare(
    `SELECT id AS work_unit_id, COALESCE(ledger_issue_id, issue_id) AS issue_id,
            worker_provider_session_id
     FROM work_units
     WHERE state = 'resolved'
       AND auth_request_id = ?
       AND worker_provider_session_id IS NOT NULL`,
  ).all(requestId) as DirectWorkUnitCandidateRow[];
}

function candidateRowsFromRequestWorkUnits(db: Db, requestId: string): CandidateRow[] {
  if (!tableExists(db, "console_sessions") || !tableHasColumn(db, "work_units", "auth_request_id")) {
    return [];
  }
  const rows: CandidateRow[] = [];
  const workUnitRows = db.prepare(
    `SELECT id, issue_id, ledger_issue_id, assigned_session_id
     FROM work_units
     WHERE state = 'resolved'
       AND auth_request_id = ?
       AND assigned_session_id IS NOT NULL`,
  ).all(requestId) as Array<{
    id: string;
    issue_id: string;
    ledger_issue_id?: string | null;
    assigned_session_id: string | null;
  }>;

  for (const workUnit of workUnitRows) {
    const issueId = workUnit.ledger_issue_id ?? workUnit.issue_id;
    if (!issueId || !workUnit.assigned_session_id) continue;

    rows.push(...consoleSessionRowsForLink(db, {
      issueId,
      workUnitId: workUnit.id,
      sessionId: workUnit.assigned_session_id,
    }));
  }
  return rows;
}

function candidateRowsFromIssueSessionLinks(db: Db, issueIds: Set<string>): CandidateRow[] {
  const rows: CandidateRow[] = [];
  const linkedSessions = new Map<string, string>();

  const ids = [...issueIds];
  const linkRows = db.prepare(
    `SELECT session_id, issue_id FROM ledger_session_issue_links
     WHERE issue_id IN (${ids.map(() => "?").join(", ")})
     ORDER BY created_at ASC`,
  ).all(...ids) as Array<{ session_id: string; issue_id: string }>;
  for (const row of linkRows) {
    if (issueIds.has(row.issue_id) && !linkedSessions.has(row.session_id)) {
      linkedSessions.set(row.session_id, row.issue_id);
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

function allParentRoleSessionIds(db: Db): Set<string> {
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
    const providerSessionId = typeof payload?.provider_session_id === "string"
      ? payload.provider_session_id
      : null;
    if (sessionId) ids.add(sessionId);
    if (providerSessionId) ids.add(providerSessionId);
  }
  expandConsoleSessionAliases(db, ids);
  return ids;
}

function expandConsoleSessionAliases(db: Db, ids: Set<string>): void {
  if (!tableExists(db, "console_sessions") || ids.size === 0) return;
  const rows = db.prepare(
    `SELECT id, mandible_session_id, provider_session_id
     FROM console_sessions
     WHERE id = ?
        OR mandible_session_id = ?
        OR provider_session_id = ?`,
  );
  for (const id of [...ids]) {
    const matches = rows.all(id, id, id) as Array<{
      id?: string | null;
      mandible_session_id?: string | null;
      provider_session_id?: string | null;
    }>;
    for (const match of matches) {
      for (const value of [match.id, match.mandible_session_id, match.provider_session_id]) {
        const normalized = stringOrNull(value);
        if (normalized) ids.add(normalized);
      }
    }
  }
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

function tableHasColumn(db: Db, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
