import { IssueScanner } from "../issue-scanner.js";
import { WorkScanner } from "../work-scanner.js";
import { getDb } from "../db.js";

export interface RouteHandler<Request = unknown, Response = unknown> {
  (req: Request, res: Response): void | Promise<void>;
}

export interface IssueServer {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put?(path: string, handler: RouteHandler): void;
}

function getParam(req: unknown, key: string): string | undefined {
  if (!req || typeof req !== "object") {
    return undefined;
  }
  const record = req as Record<string, unknown>;
  if (record.params && typeof record.params === "object") {
    const params = record.params as Record<string, unknown>;
    if (typeof params[key] === "string") {
      return params[key] as string;
    }
  }
  if (typeof record.param === "function") {
    const value = (record.param as (k: string) => unknown)(key);
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function getQueryParam(req: unknown, key: string): string | undefined {
  if (!req || typeof req !== "object") {
    return undefined;
  }
  const record = req as Record<string, unknown>;
  if (!record.query || typeof record.query !== "object") {
    return undefined;
  }
  const query = record.query as Record<string, unknown>;
  const value = query[key];
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? (value[0] as string) : undefined;
  }
  return typeof value === "string" ? (value as string) : undefined;
}

function getBody(req: unknown): Record<string, unknown> | null {
  if (!req || typeof req !== "object") {
    return null;
  }
  const record = req as Record<string, unknown>;
  if (record.body && typeof record.body === "object") {
    return record.body as Record<string, unknown>;
  }
  return null;
}

function sendJson(res: unknown, status: number, payload: unknown): void {
  if (!res || typeof res !== "object") {
    return;
  }
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

export function registerIssueRoutes(
  server: IssueServer,
  workScanner: WorkScanner,
): IssueScanner {
  const issueScanner = new IssueScanner(workScanner);

  // GET /api/issues — list repo summaries with optional filtering
  server.get("/api/issues", (req, res) => {
    const repoFilter = getQueryParam(req, "repo");
    const statusFilter = getQueryParam(req, "status");
    const labelFilter = getQueryParam(req, "label");

    let summaries = issueScanner.getRepoSummaries();

    if (repoFilter) {
      summaries = summaries.filter(
        (s) => s.repo_id === repoFilter || s.repo_name === repoFilter,
      );
    }

    // Bug: e32ee8b — three-state filter: "merged" = closed + has "merged" label
    if (statusFilter === "open" || statusFilter === "closed" || statusFilter === "merged") {
      summaries = summaries.map((s) => ({
        ...s,
        issues: s.issues.filter((issue) => {
          if (statusFilter === "merged") {
            return issue.status === "closed" && issue.labels.includes("merged");
          }
          if (statusFilter === "closed") {
            // "closed" filter excludes merged issues (they have their own state)
            return issue.status === "closed" && !issue.labels.includes("merged");
          }
          return issue.status === statusFilter;
        }),
      }));
    }

    if (labelFilter) {
      summaries = summaries.map((s) => ({
        ...s,
        issues: s.issues.filter((issue) =>
          issue.labels.some(
            (label) => label.toLowerCase() === labelFilter.toLowerCase(),
          ),
        ),
      }));
    }

    // Filter out repos with no matching issues after filters
    summaries = summaries.filter((s) => s.issues.length > 0 || (!statusFilter && !labelFilter));

    sendJson(res, 200, summaries);
  });

  // GET /api/issues/find/:issueId — search all scanned repos for an issue by ID prefix.
  // Registered before /:repoId/:issueId to avoid the literal "find" being treated as repoId.
  server.get("/api/issues/find/:issueId", (req, res) => {
    const issueId = getParam(req, "issueId");
    if (!issueId) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const detail = issueScanner.findIssueAcrossRepos(issueId);
    if (!detail) {
      sendJson(res, 404, { error: "issue not found in any scanned repo" });
      return;
    }
    sendJson(res, 200, detail);
  });

  // GET /api/issues/:repoId/:issueId — issue detail with comments
  server.get("/api/issues/:repoId/:issueId", (req, res) => {
    const repoIdParam = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoIdParam || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    let repoId = repoIdParam;
    let detail = issueScanner.getIssueDetail(repoId, issueId);
    if (!detail) {
      const byName = issueScanner
        .getRepoSummaries()
        .find((summary) => summary.repo_name === repoIdParam || summary.repo_root === repoIdParam);
      if (byName) {
        repoId = byName.repo_id;
        detail = issueScanner.getIssueDetail(repoId, issueId);
      }
    }
    if (!detail) {
      sendJson(res, 404, { error: "issue not found" });
      return;
    }
    sendJson(res, 200, detail);
  });

  // POST /api/issues/:repoId/:issueId/status — close or reopen
  server.post("/api/issues/:repoId/:issueId/status", (req, res) => {
    const repoId = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoId || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const body = getBody(req);
    const newStatus = body?.status;
    if (newStatus !== "open" && newStatus !== "closed") {
      sendJson(res, 400, { error: "status must be 'open' or 'closed'" });
      return;
    }
    const ok = newStatus === "closed"
      ? issueScanner.closeIssue(repoId, issueId)
      : issueScanner.reopenIssue(repoId, issueId);
    if (!ok) {
      sendJson(res, 500, { error: "failed to update issue status" });
      return;
    }
    sendJson(res, 200, { ok: true });
  });

  // POST /api/issues/:repoId/:issueId/comment — add comment
  server.post("/api/issues/:repoId/:issueId/comment", (req, res) => {
    const repoId = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoId || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const body = getBody(req);
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message.trim()) {
      sendJson(res, 400, { error: "message is required" });
      return;
    }
    const ok = issueScanner.addComment(repoId, issueId, message);
    if (!ok) {
      sendJson(res, 500, { error: "failed to add comment" });
      return;
    }
    sendJson(res, 200, { ok: true });
  });

  // POST /api/issues/:repoId/:issueId/label — add or remove label
  server.post("/api/issues/:repoId/:issueId/label", (req, res) => {
    const repoId = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoId || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const body = getBody(req);
    const action = body?.action;
    const label = typeof body?.label === "string" ? body.label : "";
    if (action !== "add" && action !== "remove") {
      sendJson(res, 400, { error: "action must be 'add' or 'remove'" });
      return;
    }
    if (!label.trim()) {
      sendJson(res, 400, { error: "label is required" });
      return;
    }
    const ok = action === "add"
      ? issueScanner.addLabel(repoId, issueId, label)
      : issueScanner.removeLabel(repoId, issueId, label);
    if (!ok) {
      sendJson(res, 500, { error: `failed to ${action} label` });
      return;
    }
    sendJson(res, 200, { ok: true });
  });

  // POST /api/issues/scan — force rescan all repos
  server.post("/api/issues/scan", async (_req, res) => {
    const summaries = await issueScanner.scanAllAsync();
    sendJson(res, 200, summaries);
  });

  // POST /api/issues/:repoId/scan — force-scan a single repo by ID.
  // Used by the UI to unblock deep-link 404s on daemon reload: if the
  // IssueScanner hasn't scanned a repo yet, the UI can trigger a targeted
  // scan and retry the detail fetch rather than showing "Failed to load".
  server.post("/api/issues/:repoId/scan", async (req, res) => {
    const repoId = getParam(req, "repoId");
    if (!repoId) {
      sendJson(res, 400, { error: "missing repoId" });
      return;
    }
    const ok = await issueScanner.scanRepoByIdAsync(repoId);
    if (!ok) {
      sendJson(res, 404, { error: "repo not found" });
      return;
    }
    sendJson(res, 200, { ok: true });
  });


  // GET /api/issues/:repoId/:issueId/sessions — get linked sessions for an issue
  server.get("/api/issues/:repoId/:issueId/sessions", (req, res) => {
    const repoIdParam = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoIdParam || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    let repoId = repoIdParam;
    const byName = issueScanner
      .getRepoSummaries()
      .find((summary) => summary.repo_name === repoIdParam || summary.repo_root === repoIdParam);
    if (byName) {
      repoId = byName.repo_id;
    }
    const db = getDb();
    const links = db.prepare(
      `SELECT session_id, issue_id, repo_id, created_at
       FROM session_issues
       WHERE issue_id = ? AND repo_id = ?
       ORDER BY created_at ASC`
    ).all(issueId, repoId);
    sendJson(res, 200, links);
  });

  return issueScanner;
}
