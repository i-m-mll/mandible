import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { LivenessState } from "./contracts.js";
import type { Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { getUserHome } from "./platform-paths.js";
import {
  isLiveSessionStatus,
  sessionAliasLiveness,
  type ProviderTaskLivenessReader,
  type SessionAliasResolution,
} from "./session-liveness.js";
import { withFreshCodexTaskLiveness } from "./codex-task-liveness.js";
import SqliteDatabase from "./sqlite.js";
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

/**
 * Codex's own archived flag for a thread: true or false when its state database
 * answers, null when it cannot be read.
 */
export type CodexThreadArchivedProbe = (threadId: string) => boolean | null;

/**
 * Archive and unarchive are idempotent: `codex archive` fails on a thread that
 * is already archived (and `unarchive` on one that is not), so a failed command
 * whose thread already sits in the requested state counts as done.
 */
export class CodexCliThreadArchiver implements CodexThreadArchiver {
  constructor(
    private readonly execFile: CodexCommandRunner = execFileAsync,
    private readonly archivedProbe: CodexThreadArchivedProbe = readCodexThreadArchived,
  ) {}

  async archive(threadId: string): Promise<void> {
    await this.run("archive", threadId);
  }

  async unarchive(threadId: string): Promise<void> {
    await this.run("unarchive", threadId);
  }

  private async run(command: CodexThreadArchiveCommand, threadId: string): Promise<void> {
    try {
      await this.execFile("codex", [command, threadId], {
        timeout: 15_000,
      });
    } catch (error) {
      if (this.archivedProbe(threadId) === (command === "archive")) return;
      throw error;
    }
  }
}

/** Read the `archived` flag from the newest `state_<n>.sqlite` under the Codex home. */
export function readCodexThreadArchived(threadId: string): boolean | null {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(getUserHome(), ".codex");
  let stateDb: string | null = null;
  let newest = -1;
  try {
    for (const name of fs.readdirSync(codexHome)) {
      const match = /^state_(\d+)\.sqlite$/.exec(name);
      if (match && Number(match[1]) > newest) {
        newest = Number(match[1]);
        stateDb = path.join(codexHome, name);
      }
    }
  } catch {
    return null;
  }
  if (!stateDb) return null;
  let db: SqliteDatabase | null = null;
  try {
    db = new SqliteDatabase(stateDb, { readonly: true, fileMustExist: true, timeout: 2000 });
    const row = db.prepare("SELECT archived FROM threads WHERE id = ?").get(threadId) as
      | { archived: unknown }
      | undefined;
    return row ? Number(row.archived) === 1 : null;
  } catch {
    return null;
  } finally {
    db?.close();
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

/** Archive candidates for a completed merge; a thread qualifies only on a Codex lock scan made for this listing. */
export function listCompletedWorkerThreadArchiveCandidates(
  db: Db,
  request: AuthRequest,
): Promise<WorkerThreadArchiveCandidate[]> {
  return withFreshCodexTaskLiveness((read) => completedWorkerThreadArchiveCandidates(db, request, read));
}

function completedWorkerThreadArchiveCandidates(
  db: Db,
  request: AuthRequest,
  read: ProviderTaskLivenessReader,
): WorkerThreadArchiveCandidate[] {
  if (!tableExists(db, "work_units")) {
    return [];
  }

  const parentRoleSessionIds = allParentRoleSessionIds(db);
  const byProviderId = new Map<string, WorkerThreadArchiveCandidate>();
  const closureIssueIds = completedIssueIds(db, request);

  for (const row of candidateRowsFromRequestWorkUnits(db, request.id)) {
    addCandidate(db, byProviderId, row, parentRoleSessionIds, read);
  }

  if (closureIssueIds.size > 0) {
    if (tableExists(db, "console_sessions") && tableExists(db, "ledger_session_issue_links")) {
      for (const row of candidateRowsFromIssueSessionLinks(db, closureIssueIds)) {
        addCandidate(db, byProviderId, row, parentRoleSessionIds, read);
      }
    }
  }

  return selectConservativeArchiveCandidates(Array.from(byProviderId.values()), closureIssueIds);
}

function addCandidate(
  db: Db,
  byProviderId: Map<string, WorkerThreadArchiveCandidate>,
  row: CandidateRow,
  parentRoleSessionIds: Set<string>,
  read: ProviderTaskLivenessReader,
): void {
  const providerSessionId = stringOrNull(row.provider_session_id);
  const consoleSessionId = stringOrNull(row.console_session_id);
  if (!providerSessionId || !consoleSessionId) return;
  if (row.command !== "codex") return;
  if (isLiveSessionStatus(row.console_status) || isLiveSessionStatus(row.mandible_status)) return;
  if (sessionAliasLiveness(db, providerSessionId, { readCodexTaskLiveness: read }) !== "stopped") return;

  const mandibleSessionId = stringOrNull(row.mandible_session_id);
  if (
    parentRoleSessionIds.has(providerSessionId) ||
    parentRoleSessionIds.has(consoleSessionId) ||
    (mandibleSessionId != null && parentRoleSessionIds.has(mandibleSessionId))
  ) {
    return;
  }

  addArchiveCandidate(byProviderId, {
    provider_session_id: providerSessionId,
    console_session_id: consoleSessionId,
    mandible_session_id: mandibleSessionId,
    issue_id: String(row.issue_id),
    work_unit_id: stringOrNull(row.work_unit_id),
  });
}

function addArchiveCandidate(
  byProviderId: Map<string, WorkerThreadArchiveCandidate>,
  candidate: WorkerThreadArchiveCandidate,
): void {
  const existing = byProviderId.get(candidate.provider_session_id);
  if (!existing || compareWorkerThreadArchiveCandidates(candidate, existing) < 0) {
    byProviderId.set(candidate.provider_session_id, candidate);
  }
}

function selectConservativeArchiveCandidates(
  candidates: WorkerThreadArchiveCandidate[],
  closureIssueIds: Set<string>,
): WorkerThreadArchiveCandidate[] {
  const byClosureIssue = new Map<string, WorkerThreadArchiveCandidate>();
  const selected: WorkerThreadArchiveCandidate[] = [];

  for (const candidate of candidates) {
    if (!closureIssueIds.has(candidate.issue_id)) {
      selected.push(candidate);
      continue;
    }
    const existing = byClosureIssue.get(candidate.issue_id);
    if (!existing || compareWorkerThreadArchiveCandidates(candidate, existing) < 0) {
      byClosureIssue.set(candidate.issue_id, candidate);
    }
  }

  selected.push(...byClosureIssue.values());
  return selected
    .sort((a, b) => a.provider_session_id.localeCompare(b.provider_session_id));
}

function compareWorkerThreadArchiveCandidates(
  a: WorkerThreadArchiveCandidate,
  b: WorkerThreadArchiveCandidate,
): number {
  return (
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

export type WorkerThreadLiveness = (db: Db, threadId: string) => LivenessState | Promise<LivenessState>;
export type WorkerThreadAliasResolver = (db: Db, id: string) => SessionAliasResolution | null;

export interface FinishedWorkerThreadArchivePass {
  /** Archived threads, with how many failed attempts preceded this success. */
  archived: Array<{ thread_id: string; prior_attempts: number }>;
  /** Threads whose liveness could not be established; reconsidered next pass. */
  deferred: string[];
  /** Failed attempts, with the attempt count now recorded for the thread. */
  failed: Array<{ thread_id: string; attempts: number; error: string }>;
}

const ARCHIVE_RETRY_BASE_MS = 60_000;
const ARCHIVE_RETRY_MAX_MS = 6 * 60 * 60_000;

/** Delay before the next attempt after `attempts` consecutive failures. */
export function workerThreadArchiveRetryDelayMs(attempts: number): number {
  return Math.min(ARCHIVE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), ARCHIVE_RETRY_MAX_MS);
}

/**
 * Archive each Codex worker thread whose bound work is finished, once per
 * resolved work unit.
 *
 * A unit's worker thread is the one `work-unit activate --worker` bound. Its
 * work is finished once the unit is resolved, by whatever path resolved it: a
 * merge request, the merge's ancestry scan, `wt merge` into a parent branch, or
 * an explicit resolve. `worker_thread_archives` records the archive per unit
 * and thread, so a thread later unarchived by the user or a follow-up dispatch
 * is archived again only when another of its units resolves. A failed attempt
 * is recorded on the same rows and retried with exponential backoff.
 *
 * A thread is archived only when its liveness is definitely `stopped`, it has
 * never held an umbrella parent role, and no open or committed unit names it
 * under any of its aliases. `unknown` liveness defers to a later pass.
 */
export async function archiveFinishedWorkerThreads(
  db: Db,
  input: {
    archiver: CodexThreadArchiver;
    liveness: WorkerThreadLiveness;
    resolveAlias: WorkerThreadAliasResolver;
    now: () => number;
  },
): Promise<FinishedWorkerThreadArchivePass> {
  const pass: FinishedWorkerThreadArchivePass = { archived: [], deferred: [], failed: [] };
  const now = input.now();
  const rows = db.prepare(
    `SELECT wu.id AS work_unit_id, wu.worker_provider_session_id AS thread_id,
            COALESCE(a.attempts, 0) AS attempts, a.next_retry_at
     FROM work_units wu
     LEFT JOIN worker_thread_archives a
       ON a.work_unit_id = wu.id AND a.thread_id = wu.worker_provider_session_id
     WHERE wu.state = 'resolved'
       AND wu.worker_provider_session_id IS NOT NULL
       AND trim(wu.worker_provider_session_id) != ''
       AND a.archived_at IS NULL
     ORDER BY wu.worker_provider_session_id, wu.id`,
  ).all() as Array<{ work_unit_id: string; thread_id: string; attempts: number; next_retry_at: number | null }>;

  const threads = new Map<string, { units: string[]; attempts: number; due: boolean }>();
  for (const row of rows) {
    const thread = threads.get(row.thread_id) ?? { units: [], attempts: 0, due: true };
    thread.units.push(row.work_unit_id);
    thread.attempts = Math.max(thread.attempts, Number(row.attempts));
    if (row.next_retry_at != null && row.next_retry_at > now) thread.due = false;
    threads.set(row.thread_id, thread);
  }
  const due = [...threads].filter(([, thread]) => thread.due);
  if (due.length === 0) return pass;

  const parentRoleSessionIds = allParentRoleSessionIds(db);
  const busy = threadsHoldingUnfinishedWork(db, input.resolveAlias);
  const recordArchived = db.prepare(
    `INSERT INTO worker_thread_archives (work_unit_id, thread_id, archived_at, attempts)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(work_unit_id, thread_id)
     DO UPDATE SET archived_at = excluded.archived_at, next_retry_at = NULL`,
  );
  const recordFailure = db.prepare(
    `INSERT INTO worker_thread_archives (work_unit_id, thread_id, attempts, last_error, next_retry_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(work_unit_id, thread_id)
     DO UPDATE SET attempts = excluded.attempts, last_error = excluded.last_error,
       next_retry_at = excluded.next_retry_at`,
  );

  for (const [threadId, thread] of due) {
    if (parentRoleSessionIds.has(threadId) || busy.has(threadId)) continue;
    const liveness = await input.liveness(db, threadId);
    if (liveness === "live") continue;
    if (liveness === "unknown") {
      pass.deferred.push(threadId);
      continue;
    }
    try {
      await input.archiver.archive(threadId);
    } catch (error) {
      const attempts = thread.attempts + 1;
      const message = errorMessage(error);
      const retryAt = input.now() + workerThreadArchiveRetryDelayMs(attempts);
      db.transaction(() => {
        for (const unit of thread.units) recordFailure.run(unit, threadId, attempts, message, retryAt);
      })();
      pass.failed.push({ thread_id: threadId, attempts, error: message });
      continue;
    }
    const archivedAt = input.now();
    db.transaction(() => {
      for (const unit of thread.units) recordArchived.run(unit, threadId, archivedAt);
    })();
    pass.archived.push({ thread_id: threadId, prior_attempts: thread.attempts });
  }
  return pass;
}

/** Every alias of every session recorded on an open or committed work unit. */
function threadsHoldingUnfinishedWork(db: Db, resolveAlias: WorkerThreadAliasResolver): Set<string> {
  const held = new Set<string>();
  const rows = db.prepare(
    `SELECT assigned_session_id, worker_provider_session_id, provider_session_id
     FROM work_units
     WHERE state IN ('open', 'committed')`,
  ).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    for (const value of [row.assigned_session_id, row.worker_provider_session_id, row.provider_session_id]) {
      const id = stringOrNull(value)?.trim();
      if (!id || held.has(id)) continue;
      held.add(id);
      const resolution = resolveAlias(db, id);
      for (const alias of [
        resolution?.provider_session_id,
        resolution?.mandible_session_id,
        resolution?.console_session_id,
      ]) {
        if (alias) held.add(alias);
      }
    }
  }
  return held;
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
