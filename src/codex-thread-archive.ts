import { execFileSync } from "node:child_process";
import type { Db } from "./db.js";
import type { AuthRequest } from "./types.js";

const CODEX_APP_SERVER_REQUEST_ID = 1;

export interface CodexThreadArchiver {
  archive(threadId: string): void;
  unarchive(threadId: string): void;
}

export interface WorkerThreadArchiveCandidate {
  provider_session_id: string;
  console_session_id: string | null;
  mandible_session_id: string | null;
  issue_id: string;
  work_unit_id: string | null;
}

type CodexProxyRunner = typeof execFileSync;
type CodexThreadArchiveMethod = "thread/archive" | "thread/unarchive";

export class CodexCliThreadArchiver implements CodexThreadArchiver {
  constructor(private readonly execFile: CodexProxyRunner = execFileSync) {}

  archive(threadId: string): void {
    this.run("thread/archive", threadId);
  }

  unarchive(threadId: string): void {
    this.run("thread/unarchive", threadId);
  }

  private run(method: CodexThreadArchiveMethod, threadId: string): void {
    const response = this.execFile("codex", ["app-server", "proxy"], {
      input: encodeAppServerMessage({
        id: CODEX_APP_SERVER_REQUEST_ID,
        method,
        params: { threadId },
      }),
      stdio: "pipe",
      timeout: 15_000,
    });
    assertSuccessfulAppServerResponse(method, response);
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
  if (!tableExists(db, "work_units")) {
    return [];
  }

  const liveParentSessionIds = activeParentRoleSessionIds(db);
  const byProviderId = new Map<string, WorkerThreadArchiveCandidate>();

  for (const row of directCandidateRowsFromRequestWorkUnits(db, request.id)) {
    addDirectWorkUnitCandidate(db, byProviderId, row, liveParentSessionIds);
  }

  for (const row of candidateRowsFromRequestWorkUnits(db, request.id)) {
    addCandidate(byProviderId, row, liveParentSessionIds);
  }

  const issueIds = completedIssueIds(db, request);
  if (issueIds.size > 0) {
    for (const row of directCandidateRowsFromWorkUnits(db, issueIds)) {
      addDirectWorkUnitCandidate(db, byProviderId, row, liveParentSessionIds);
    }

    for (const row of candidateRowsFromWorkUnits(db, issueIds)) {
      addCandidate(byProviderId, row, liveParentSessionIds);
    }

    if (tableExists(db, "console_sessions") && tableExists(db, "session_issues")) {
      for (const row of candidateRowsFromLegacyIssueSessions(db, issueIds)) {
        addCandidate(byProviderId, row, liveParentSessionIds);
      }
    }
  }

  return Array.from(byProviderId.values()).sort((a, b) =>
    a.provider_session_id.localeCompare(b.provider_session_id),
  );
}

function addDirectWorkUnitCandidate(
  db: Db,
  byProviderId: Map<string, WorkerThreadArchiveCandidate>,
  row: DirectWorkUnitCandidateRow,
  liveParentSessionIds: Set<string>,
): void {
  const providerSessionId = stringOrNull(row.provider_session_id);
  if (row.provider !== "codex" || !providerSessionId) return;
  if (liveParentSessionIds.has(providerSessionId) || isProviderSessionLive(db, providerSessionId)) return;

  byProviderId.set(providerSessionId, {
    provider_session_id: providerSessionId,
    console_session_id: null,
    mandible_session_id: null,
    issue_id: String(row.issue_id),
    work_unit_id: String(row.work_unit_id),
  });
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

interface DirectWorkUnitCandidateRow {
  provider: string | null;
  provider_session_id: string | null;
  issue_id: string;
  work_unit_id: string;
}

function directCandidateRowsFromRequestWorkUnits(db: Db, requestId: string): DirectWorkUnitCandidateRow[] {
  if (!tableHasColumn(db, "work_units", "auth_request_id")) {
    return [];
  }
  return db.prepare(
    `SELECT id AS work_unit_id, COALESCE(ledger_issue_id, issue_id) AS issue_id, provider, provider_session_id
     FROM work_units
     WHERE state = 'resolved'
       AND auth_request_id = ?
       AND provider = 'codex'
       AND provider_session_id IS NOT NULL`,
  ).all(requestId) as DirectWorkUnitCandidateRow[];
}

function directCandidateRowsFromWorkUnits(db: Db, issueIds: Set<string>): DirectWorkUnitCandidateRow[] {
  const rows: DirectWorkUnitCandidateRow[] = [];
  const workUnitRows = db.prepare(
    `SELECT id, issue_id, ledger_issue_id, provider, provider_session_id
     FROM work_units
     WHERE state = 'resolved'
       AND provider = 'codex'
       AND provider_session_id IS NOT NULL`,
  ).all() as Array<{
    id: string;
    issue_id: string;
    ledger_issue_id?: string | null;
    provider: string | null;
    provider_session_id: string | null;
  }>;

  for (const workUnit of workUnitRows) {
    const issueId = workUnit.ledger_issue_id && issueIds.has(workUnit.ledger_issue_id)
      ? workUnit.ledger_issue_id
      : issueIds.has(workUnit.issue_id)
        ? workUnit.issue_id
        : null;
    if (!issueId) continue;
    rows.push({
      provider: workUnit.provider,
      provider_session_id: workUnit.provider_session_id,
      issue_id: issueId,
      work_unit_id: workUnit.id,
    });
  }
  return rows;
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

function candidateRowsFromWorkUnits(db: Db, issueIds: Set<string>): CandidateRow[] {
  if (!tableExists(db, "console_sessions")) {
    return [];
  }
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

function candidateRowsFromLegacyIssueSessions(db: Db, issueIds: Set<string>): CandidateRow[] {
  const rows: CandidateRow[] = [];
  const linkedSessions = new Map<string, string>();

  const legacyRows = db.prepare(
    "SELECT session_id, issue_id FROM session_issues",
  ).all() as Array<{ session_id: string; issue_id: string }>;
  for (const row of legacyRows) {
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

function isProviderSessionLive(db: Db, providerSessionId: string): boolean {
  if (isSessionLive(db, providerSessionId)) return true;
  if (!tableExists(db, "console_sessions")) return false;
  const rows = tableExists(db, "sessions")
    ? db.prepare(
      `SELECT cs.status AS console_status, s.status AS mandible_status
       FROM console_sessions cs
       LEFT JOIN sessions s ON s.id = COALESCE(cs.mandible_session_id, ?)
       WHERE cs.id = ?
          OR cs.mandible_session_id = ?
          OR cs.provider_session_id = ?`,
    ).all(
      providerSessionId,
      providerSessionId,
      providerSessionId,
      providerSessionId,
    ) as Array<{ console_status?: string | null; mandible_status?: string | null }>
    : db.prepare(
      `SELECT cs.status AS console_status, NULL AS mandible_status
       FROM console_sessions cs
       WHERE cs.id = ?
          OR cs.mandible_session_id = ?
          OR cs.provider_session_id = ?`,
    ).all(
      providerSessionId,
      providerSessionId,
      providerSessionId,
    ) as Array<{ console_status?: string | null; mandible_status?: string | null }>;
  return rows.some((row) =>
    isLiveSessionStatus(row.console_status) || isLiveSessionStatus(row.mandible_status)
  );
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

function tableHasColumn(db: Db, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeAppServerMessage(message: Record<string, unknown>): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function assertSuccessfulAppServerResponse(
  method: CodexThreadArchiveMethod,
  output: string | Buffer,
): void {
  const messages = decodeAppServerMessages(output);
  if (messages.length === 0) {
    throw new Error(`codex app-server ${method} returned no response`);
  }

  const response = messages.find((message) =>
    isRecord(message) && message.id === CODEX_APP_SERVER_REQUEST_ID
  );
  if (!response) {
    throw new Error(`codex app-server ${method} returned no matching response`);
  }

  if (isRecord(response) && isRecord(response.error)) {
    const message = typeof response.error.message === "string"
      ? response.error.message
      : JSON.stringify(response.error);
    throw new Error(`codex app-server ${method} failed: ${message}`);
  }
}

function decodeAppServerMessages(output: string | Buffer): unknown[] {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output, "utf8");
  const messages: unknown[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    while (offset < bytes.length && isAsciiWhitespace(bytes[offset])) {
      offset += 1;
    }
    if (offset >= bytes.length) break;

    const headerEnd = bytes.indexOf("\r\n\r\n", offset, "utf8");
    if (headerEnd === -1) {
      return decodeNewlineDelimitedJson(bytes.subarray(offset).toString("utf8"));
    }

    const headers = bytes.subarray(offset, headerEnd).toString("utf8").split("\r\n");
    const contentLengthHeader = headers.find((header) => /^content-length:/i.test(header));
    const match = contentLengthHeader?.match(/^content-length:\s*(\d+)\s*$/i);
    if (!match) {
      throw new Error("codex app-server proxy response is missing Content-Length");
    }

    const bodyStart = headerEnd + 4;
    const bodyLength = Number(match[1]);
    const bodyEnd = bodyStart + bodyLength;
    if (bodyEnd > bytes.length) {
      throw new Error("codex app-server proxy response ended before Content-Length bytes");
    }

    messages.push(JSON.parse(bytes.subarray(bodyStart, bodyEnd).toString("utf8")));
    offset = bodyEnd;
  }

  return messages;
}

function decodeNewlineDelimitedJson(output: string): unknown[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  return trimmed.split(/\r?\n/).map((line) => JSON.parse(line));
}

function isAsciiWhitespace(byte: number | undefined): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
