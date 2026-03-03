import path from "node:path";
import { getDb } from "../db.js";
import type { IssueScanner } from "../issue-scanner.js";
import type { SessionRegistry } from "../registry.js";
import type { AuthRequestStatus } from "../types.js";

export interface InboxRouteServer {
  get(path: string, handler: (req: unknown, res: unknown) => void): void;
  post(path: string, handler: (req: unknown, res: unknown) => void): void;
}

function getQueryParam(req: unknown, key: string): string | undefined {
  if (!req || typeof req !== "object") return undefined;
  const record = req as Record<string, unknown>;
  if (!record.query || typeof record.query !== "object") return undefined;
  const query = record.query as Record<string, unknown>;
  const value = query[key];
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? (value[0] as string) : undefined;
  }
  return typeof value === "string" ? (value as string) : undefined;
}

function getParam(req: unknown, key: string): string | undefined {
  if (!req || typeof req !== "object") return undefined;
  const record = req as Record<string, unknown>;
  if (record.params && typeof record.params === "object") {
    const params = record.params as Record<string, unknown>;
    if (typeof params[key] === "string") return params[key] as string;
  }
  if (typeof record.param === "function") {
    const value = (record.param as (k: string) => unknown)(key);
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function getBody(req: unknown): Record<string, unknown> | null {
  if (!req || typeof req !== "object") return null;
  const record = req as Record<string, unknown>;
  if (record.body && typeof record.body === "object") {
    return record.body as Record<string, unknown>;
  }
  return null;
}

function sendJson(res: unknown, status: number, payload: unknown): void {
  if (!res || typeof res !== "object") return;
  const record = res as Record<string, unknown>;
  if (typeof record.status === "function") {
    (record.status as (code: number) => void)(status);
  } else if (typeof record.code === "function") {
    (record.code as (code: number) => void)(status);
  }
  if (typeof record.json === "function") {
    (record.json as (body: unknown) => void)(payload);
    return;
  }
  if (typeof record.send === "function") {
    (record.send as (body: unknown) => void)(payload);
    return;
  }
  if (typeof record.end === "function") {
    (record.end as (body: string) => void)(JSON.stringify(payload));
  }
}

interface ContinuationRow {
  id: string;
  branch: string;
  continuation: string;
  ended_at: string;
  cwd: string | null;
}

interface AuthResultRow {
  id: string;
  title: string;
  status: AuthRequestStatus;
  exit_code: number | null;
  error: string | null;
  head_branch: string | null;
  resolved_at: number | null;
  repo: string | null;
  base_branch: string | null;
}

export function registerInboxRoutes(
  server: InboxRouteServer,
  _sessionRegistry: SessionRegistry,
  issueScanner: IssueScanner,
): void {
  const db = getDb();

  // GET /api/inbox — unified query of pending items for a branch
  server.get("/api/inbox", (req, res) => {
    const branch = getQueryParam(req, "branch");
    const repo = getQueryParam(req, "repo");
    const sessionId = getQueryParam(req, "session_id") ?? "";

    // Continuations: ended/dead sessions with unacknowledged continuation notes
    const continuations = branch
      ? (db
          .prepare(
            `SELECT id, branch, continuation, ended_at FROM sessions
             WHERE branch = ? AND continuation IS NOT NULL AND continuation_acked_by IS NULL
               AND status IN ('ended', 'dead') AND id != ?
             ORDER BY ended_at DESC`
          )
          .all(branch, sessionId) as ContinuationRow[])
      : (db
          .prepare(
            `SELECT id, branch, continuation, ended_at FROM sessions
             WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL
               AND status IN ('ended', 'dead')
             ORDER BY ended_at DESC`
          )
          .all() as ContinuationRow[]);

    // Auth results: resolved auth requests for this branch, unacknowledged
    const authResults = branch
      ? (db
          .prepare(
            `SELECT id, title, status, exit_code, error, head_branch, resolved_at FROM auth_requests
             WHERE head_branch = ? AND status IN ('completed', 'rejected', 'expired', 'dismissed')
               AND acknowledged_by IS NULL
             ORDER BY resolved_at DESC`
          )
          .all(branch) as AuthResultRow[])
      : (db
          .prepare(
            `SELECT id, title, status, exit_code, error, head_branch, resolved_at FROM auth_requests
             WHERE status IN ('completed', 'rejected', 'expired', 'dismissed')
               AND acknowledged_by IS NULL
             ORDER BY resolved_at DESC`
          )
          .all() as AuthResultRow[]);

    // Open issues: from issue scanner, filtered by repo
    let openIssues: Array<{ id: string; title: string; labels: string[] }> = [];
    if (repo) {
      const summaries = issueScanner.getRepoSummaries();
      for (const summary of summaries) {
        if (summary.repo_root === repo || summary.repo_name === repo || summary.repo_id === repo) {
          openIssues = summary.issues
            .filter((issue) => issue.status === "open")
            .map((issue) => ({
              id: issue.id,
              title: issue.title,
              labels: issue.labels,
            }));
          break;
        }
      }
    }

    const total = continuations.length + authResults.length + openIssues.length;

    sendJson(res, 200, {
      continuations: continuations.map((row) => ({
        session_id: row.id,
        continuation: row.continuation,
        branch: row.branch,
        ended_at: row.ended_at,
      })),
      auth_results: authResults.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        exit_code: row.exit_code,
        error: row.error,
        head_branch: row.head_branch,
        resolved_at: row.resolved_at,
      })),
      open_issues: openIssues,
      total,
    });
  });

  // GET /api/inbox/global — all unacknowledged items across all branches and repos
  server.get("/api/inbox/global", (req, res) => {
    // Continuations: all unacknowledged, any branch
    const continuations = db
      .prepare(
        `SELECT id, branch, continuation, ended_at, cwd FROM sessions
         WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL
           AND status IN ('ended', 'dead')
         ORDER BY ended_at DESC`
      )
      .all() as ContinuationRow[];

    // Auth results: all unacknowledged
    const authResults = db
      .prepare(
        `SELECT id, title, status, exit_code, error, head_branch, resolved_at, repo, base_branch FROM auth_requests
         WHERE status IN ('completed', 'rejected', 'expired', 'dismissed')
           AND acknowledged_by IS NULL
         ORDER BY resolved_at DESC`
      )
      .all() as AuthResultRow[];

    // Open issues: all repos
    const openIssues: Array<{
      id: string;
      title: string;
      labels: string[];
      repo_id?: string;
      repo_name?: string;
    }> = [];
    for (const summary of issueScanner.getRepoSummaries()) {
      for (const issue of summary.issues) {
        if (issue.status === "open") {
          openIssues.push({
            id: issue.id,
            title: issue.title,
            labels: issue.labels,
            repo_id: summary.repo_id,
            repo_name: summary.repo_name,
          });
        }
      }
    }

    const total = continuations.length + authResults.length + openIssues.length;

    sendJson(res, 200, {
      continuations: continuations.map((row) => ({
        session_id: row.id,
        continuation: row.continuation,
        branch: row.branch,
        ended_at: row.ended_at,
        repo: row.cwd ? path.basename(row.cwd) : null,
      })),
      auth_results: authResults.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        exit_code: row.exit_code,
        error: row.error,
        head_branch: row.head_branch,
        resolved_at: row.resolved_at,
        repo: row.repo ?? null,
        base_branch: row.base_branch ?? null,
      })),
      open_issues: openIssues,
      total,
    });
  });

  // POST /api/inbox/ack-all — acknowledge all unacknowledged continuations and auth results
  server.post("/api/inbox/ack-all", (_req, res) => {
    db.prepare(
      "UPDATE sessions SET continuation_acked_by = 'bulk' WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL AND status IN ('ended', 'dead')"
    ).run();
    db.prepare(
      "UPDATE auth_requests SET acknowledged_by = 'bulk' WHERE status IN ('completed', 'rejected', 'expired', 'dismissed') AND acknowledged_by IS NULL"
    ).run();
    sendJson(res, 200, { ok: true });
  });

  // POST /api/inbox/:type/:id/ack — acknowledge an inbox item
  server.post("/api/inbox/:type/:id/ack", (req, res) => {
    const type = getParam(req, "type");
    const id = getParam(req, "id");
    if (!type || !id) {
      sendJson(res, 400, { error: "missing type or id" });
      return;
    }

    const body = getBody(req);
    const sessionId = typeof body?.session_id === "string" ? body.session_id : null;

    if (type === "continuation") {
      const result = db
        .prepare(
          "UPDATE sessions SET continuation_acked_by = ? WHERE id = ? AND continuation_acked_by IS NULL"
        )
        .run(sessionId ?? "manual", id);
      if (result.changes === 0) {
        sendJson(res, 404, { error: "continuation not found or already acknowledged" });
        return;
      }
      sendJson(res, 200, { ok: true });
    } else if (type === "auth_result") {
      const result = db
        .prepare(
          "UPDATE auth_requests SET acknowledged_by = ? WHERE id = ? AND acknowledged_by IS NULL"
        )
        .run(sessionId ?? "manual", id);
      if (result.changes === 0) {
        sendJson(res, 404, { error: "auth request not found or already acknowledged" });
        return;
      }
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 400, { error: "type must be 'continuation' or 'auth_result'" });
    }
  });
}
